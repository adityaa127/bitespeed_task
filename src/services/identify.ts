import { Prisma, PrismaClient, Contact } from '@prisma/client';

export type IdentifyRequest = {
  email?: string;
  phoneNumber?: string;
};

export type IdentifyResponse = {
  contact: {
    primaryContatctId: number; // API spec typo preserved intentionally
    emails: string[];
    phoneNumbers: string[];
    secondaryContactIds: number[];
  };
};

type TxClient = Prisma.TransactionClient;
const MAX_SERIALIZABLE_RETRIES = 3;

/** Normalize phone: strip spaces, dashes, dots, parentheses. */
function normalizePhone(value: string | undefined): string | undefined {
  if (value == null || typeof value !== 'string') return undefined;
  const s = value.replace(/[\s\-\.()]/g, '').trim();
  return s || undefined;
}

/** Normalize email: lowercase and trim. */
function normalizeEmail(value: string | undefined): string | undefined {
  if (value == null || typeof value !== 'string') return undefined;
  const s = value.toLowerCase().trim();
  return s || undefined;
}

function validateInput(input: IdentifyRequest) {
  const email = normalizeEmail(input.email);
  const phoneNumber = normalizePhone(input.phoneNumber);

  if (!email && !phoneNumber) {
    const err = new Error('Either email or phoneNumber must be provided');
    (err as any).statusCode = 400;
    throw err;
  }
}

async function identifyInTransaction(
  tx: TxClient,
  input: IdentifyRequest,
): Promise<IdentifyResponse> {
  const email = normalizeEmail(input.email) || undefined;
  const phoneNumber = normalizePhone(input.phoneNumber) || undefined;

  // 1. Find direct matches by email or phoneNumber
  const orConditions: Prisma.ContactWhereInput[] = [];
  if (email) orConditions.push({ email });
  if (phoneNumber) orConditions.push({ phoneNumber });

  const directMatches = await tx.contact.findMany({
    where: {
      deletedAt: null,
      OR: orConditions,
    },
    orderBy: { createdAt: 'asc' },
  });

  // 1. If no matches, create a new primary contact
  if (directMatches.length === 0) {
    const created = await tx.contact.create({
      data: {
        email,
        phoneNumber,
        linkPrecedence: 'primary',
        linkedId: null,
      },
    });

    return {
      contact: {
        primaryContatctId: created.id,
        emails: created.email ? [created.email] : [],
        phoneNumbers: created.phoneNumber ? [created.phoneNumber] : [],
        secondaryContactIds: [],
      },
    };
  }

  // 3. Expand group transitively (BFS by shared email/phone)
  const group: Contact[] = [...directMatches];
  const groupIds = new Set<number>(group.map((c) => c.id));

  while (true) {
    const emails = new Set(
      group.flatMap((c) => (c.email ? [c.email] : [])),
    );
    const phones = new Set(
      group.flatMap((c) => (c.phoneNumber ? [c.phoneNumber] : [])),
    );

    const orConditions: Prisma.ContactWhereInput[] = [];
    if (emails.size > 0) orConditions.push({ email: { in: Array.from(emails) } });
    if (phones.size > 0) orConditions.push({ phoneNumber: { in: Array.from(phones) } });

    const next = await tx.contact.findMany({
      where: {
        deletedAt: null,
        id: { notIn: Array.from(groupIds) },
        OR: orConditions,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (next.length === 0) break;

    for (const c of next) {
      group.push(c);
      groupIds.add(c.id);
    }
  }

  group.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  // 4. Find primary: oldest createdAt in group
  let primary: Contact = group[0];
  for (const c of group) {
    if (c.createdAt < primary.createdAt) {
      primary = c;
    }
  }

  // Convert any other primaries to secondary pointing to primary
  const otherPrimaries = group.filter(
    (c) => c.id !== primary.id && c.linkPrecedence === 'primary',
  );

  if (otherPrimaries.length > 0) {
    await tx.contact.updateMany({
      where: { id: { in: otherPrimaries.map((c) => c.id) } },
      data: {
        linkPrecedence: 'secondary',
        linkedId: primary.id,
      },
    });
  }

  // Recompute group rooted at primary after normalization
  const normalizedGroup = await tx.contact.findMany({
    where: {
      deletedAt: null,
      OR: [{ id: primary.id }, { linkedId: primary.id }],
    },
    orderBy: { createdAt: 'asc' },
  });

  // Use normalized values for comparison (handles legacy unnormalized DB data)
  const existingEmails = new Set(
    normalizedGroup
      .map((c: Contact) => normalizeEmail(c.email ?? undefined))
      .filter((e: string | undefined): e is string => !!e),
  );
  const existingPhones = new Set(
    normalizedGroup
      .map((c: Contact) => normalizePhone(c.phoneNumber ?? undefined))
      .filter((p: string | undefined): p is string => !!p),
  );

  // 4 & 5. Create new secondary if request introduces new email/phone
  let shouldCreateSecondary = false;
  if (email && !existingEmails.has(email)) {
    shouldCreateSecondary = true;
  }
  if (phoneNumber && !existingPhones.has(phoneNumber)) {
    shouldCreateSecondary = true;
  }

  if (shouldCreateSecondary) {
    await tx.contact.create({
      data: {
        email,
        phoneNumber,
        linkPrecedence: 'secondary',
        linkedId: primary.id,
      },
    });
  }

  // Final group after potential creation
  const finalGroup = await tx.contact.findMany({
    where: {
      deletedAt: null,
      OR: [{ id: primary.id }, { linkedId: primary.id }],
    },
    orderBy: { createdAt: 'asc' },
  });

  const freshPrimary = finalGroup.find((c: Contact) => c.id === primary.id)!;

  // Build unique emails: primary's email first (if exists), then others stable-sorted by createdAt of contact which held it
  const seenEmails = new Set<string>();
  const emails: string[] = [];
  if (freshPrimary.email) {
    emails.push(freshPrimary.email);
    seenEmails.add(freshPrimary.email);
  }
  const otherEmailsWithContact = finalGroup
    .filter((c: Contact) => c.email && !seenEmails.has(c.email!))
    .map((c: Contact) => ({ email: c.email!, createdAt: c.createdAt }));
  otherEmailsWithContact.sort(
    (a: { createdAt: Date }, b: { createdAt: Date }) =>
      a.createdAt < b.createdAt ? -1 : 1,
  );
  for (const { email } of otherEmailsWithContact) {
    if (!seenEmails.has(email)) {
      seenEmails.add(email);
      emails.push(email);
    }
  }

  // Build unique phoneNumbers: primary's phone first (if exists), then others stable-sorted by createdAt of contact which held it
  const seenPhones = new Set<string>();
  const phoneNumbers: string[] = [];
  if (freshPrimary.phoneNumber) {
    phoneNumbers.push(freshPrimary.phoneNumber);
    seenPhones.add(freshPrimary.phoneNumber);
  }
  const otherPhonesWithContact = finalGroup
    .filter((c: Contact) => c.phoneNumber && !seenPhones.has(c.phoneNumber!))
    .map((c: Contact) => ({ phoneNumber: c.phoneNumber!, createdAt: c.createdAt }));
  otherPhonesWithContact.sort(
    (a: { createdAt: Date }, b: { createdAt: Date }) =>
      a.createdAt < b.createdAt ? -1 : 1,
  );
  for (const { phoneNumber } of otherPhonesWithContact) {
    if (!seenPhones.has(phoneNumber)) {
      seenPhones.add(phoneNumber);
      phoneNumbers.push(phoneNumber);
    }
  }

  // secondaryContactIds: ids where linkPrecedence = 'secondary' and linkedId = primary.id
  const secondaryContactIds = finalGroup
    .filter(
      (c: Contact) =>
        c.linkPrecedence === 'secondary' && c.linkedId === freshPrimary.id,
    )
    .map((c: Contact) => c.id)
    .sort((a: number, b: number) => a - b);

  return {
    contact: {
      primaryContatctId: freshPrimary.id,
      emails,
      phoneNumbers,
      secondaryContactIds,
    },
  };
}

export async function identifyContact(
  prisma: PrismaClient,
  input: IdentifyRequest,
): Promise<IdentifyResponse> {
  validateInput(input);

  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx: TxClient) => {
          return identifyInTransaction(tx, input);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (err: unknown) {
      const isRetryableConflict =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2034';

      if (isRetryableConflict && attempt < MAX_SERIALIZABLE_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
        continue;
      }

      console.error('Error in identifyContact:', err);
      throw err;
    }
  }

  throw new Error('Unreachable: serializable retry loop exited unexpectedly');
}

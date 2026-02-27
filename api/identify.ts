import { identifyContact, IdentifyRequest } from '../src/services/identify';
import { prisma } from './_lib/prisma';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload: IdentifyRequest = {
    email: typeof req.body?.email === 'string' ? req.body.email : undefined,
    phoneNumber:
      typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber : undefined,
  };

  try {
    const result = await identifyContact(prisma, payload);
    return res.status(200).json(result);
  } catch (err: any) {
    const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;

    return res.status(statusCode).json({
      error:
        statusCode === 400 ? err?.message || 'Invalid request' : 'Internal server error',
    });
  }
}


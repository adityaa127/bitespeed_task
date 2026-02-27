import { PrismaClient } from '@prisma/client';
import { createApp } from './app';

const prisma = new PrismaClient();
const app = createApp(prisma);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Identify service listening on port ${PORT}`);
});

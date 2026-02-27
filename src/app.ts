import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { identifyContact, IdentifyRequest } from './services/identify';

export function createApp(prisma: PrismaClient) {
  const app = express();

  app.use(express.json());

  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      message: 'Bitespeed Identity Reconciliation Service',
      endpoint: 'POST /identify',
      health: 'GET /health',
    });
  });

  app.post(
    '/identify',
    async (req: Request, res: Response, _next: NextFunction) => {
      const payload: IdentifyRequest = {
        email: typeof req.body?.email === 'string' ? req.body.email : undefined,
        phoneNumber:
          typeof req.body?.phoneNumber === 'string'
            ? req.body.phoneNumber
            : undefined,
      };

      try {
        const result = await identifyContact(prisma, payload);
        res.status(200).json(result);
      } catch (err: any) {
        const statusCode =
          typeof err?.statusCode === 'number' ? err.statusCode : 500;

        if (statusCode === 400) {
          console.warn('Bad request for /identify:', err?.message);
        } else {
          console.error('Internal error on /identify:', err);
        }

        res.status(statusCode).json({
          error:
            statusCode === 400
              ? err?.message || 'Invalid request'
              : 'Internal server error',
        });
      }
    },
  );

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

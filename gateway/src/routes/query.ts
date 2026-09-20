import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../auth.js';
import { processQuery } from '../core/engine.js';
import { addLog, getSetting } from '../db.js';
export const queryRoutes = Router();

const handleQuery = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { sessionId?: string; userId?: string; text?: string };
  if (!body.text) {
    res.status(400).json({ error: 'text erforderlich' });
    return;
  }
  const result = await processQuery({
    sessionId: body.sessionId ?? 'api-test',
    userId: body.userId,
    text: body.text,
  });
  res.json(result);
};

queryRoutes.post('/api/query', requireAuth, handleQuery);
queryRoutes.post('/admin/api/query', requireAuth, handleQuery);

const handleLambdaTrace = (req: Request, res: Response) => {
  const body = req.body as { sessionId?: string; event?: string; elapsedMs?: number; note?: string };
  if (getSetting('debug_logging') === '1') {
    addLog({
      sessionId: body.sessionId ?? 'lambda',
      query: JSON.stringify(body),
      route: `lambda-trace:${body.event ?? '?'}`,
      response: '',
      durationMs: Number(body.elapsedMs ?? 0),
      trace: [],
    });
  }
  res.status(204).end();
};
// Unter /api (nicht /admin): die LAN-only-Regel des Nginx-Vhosts blockiert sonst AWS-Lambda-IPs (403).
queryRoutes.post('/api/lambda-trace', requireAuth, handleLambdaTrace);
queryRoutes.post('/admin/api/lambda-trace', requireAuth, handleLambdaTrace);

import type { Request, Response, NextFunction } from 'express';
import { parseEmailListEnv } from '../auth/EmailListParser.js';

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const email = req.session?.email;
  if (!email) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const adminEmails = parseEmailListEnv(process.env.ADMIN_EMAILS);
  if (!adminEmails.has(email.toLowerCase())) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  next();
}

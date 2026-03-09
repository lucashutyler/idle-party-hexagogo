import type { Request, Response, NextFunction } from 'express';

function getAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? '';
  return new Set(
    raw.split(',')
      .map(e => e.trim().toLowerCase())
      .filter(e => e.length > 0)
  );
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const email = req.session?.email;
  if (!email) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const adminEmails = getAdminEmails();
  if (!adminEmails.has(email.toLowerCase())) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  next();
}

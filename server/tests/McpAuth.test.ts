import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { parseMcpTokens, mcpAuthMiddleware } from '../src/mcp/mcpAuthMiddleware.js';

describe('parseMcpTokens', () => {
  it('returns an empty map for undefined input', () => {
    expect(parseMcpTokens(undefined).size).toBe(0);
  });

  it('returns an empty map for an empty string', () => {
    expect(parseMcpTokens('').size).toBe(0);
  });

  it('gives plain comma-separated tokens the label "mcp"', () => {
    const tokens = parseMcpTokens('abc123,def456');
    expect(tokens.get('abc123')).toBe('mcp');
    expect(tokens.get('def456')).toBe('mcp');
    expect(tokens.size).toBe(2);
  });

  it('parses "label:token" pairs', () => {
    const tokens = parseMcpTokens('lucas:abc123,claude-desktop:def456');
    expect(tokens.get('abc123')).toBe('lucas');
    expect(tokens.get('def456')).toBe('claude-desktop');
    expect(tokens.size).toBe(2);
  });

  it('handles a mix of plain and labeled entries', () => {
    const tokens = parseMcpTokens('lucas:abc123,plaintoken1,claude-desktop:def456');
    expect(tokens.get('abc123')).toBe('lucas');
    expect(tokens.get('plaintoken1')).toBe('mcp');
    expect(tokens.get('def456')).toBe('claude-desktop');
    expect(tokens.size).toBe(3);
  });

  it('filters out empty/whitespace-only entries', () => {
    const tokens = parseMcpTokens('abc123, , ,def456,');
    expect(tokens.size).toBe(2);
    expect(tokens.get('abc123')).toBe('mcp');
    expect(tokens.get('def456')).toBe('mcp');
  });

  it('trims whitespace around plain tokens and label:token pairs', () => {
    const tokens = parseMcpTokens('  abc123  ,  lucas : def456  ');
    expect(tokens.get('abc123')).toBe('mcp');
    expect(tokens.get('def456')).toBe('lucas');
  });

  it('drops a "label:" entry whose token half is empty', () => {
    const tokens = parseMcpTokens('lucas:,abc123');
    expect(tokens.size).toBe(1);
    expect(tokens.get('abc123')).toBe('mcp');
  });
});

/** Minimal Express req/res/next stand-ins — enough to drive mcpAuthMiddleware. */
function makeReqRes(authorizationHeader?: string) {
  const req = {
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorizationHeader : undefined),
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('mcpAuthMiddleware', () => {
  const originalTokens = process.env.MCP_TOKENS;

  afterEach(() => {
    if (originalTokens === undefined) delete process.env.MCP_TOKENS;
    else process.env.MCP_TOKENS = originalTokens;
  });

  it('responds 404 (hiding the endpoint) when MCP_TOKENS is unset', () => {
    delete process.env.MCP_TOKENS;
    const { req, res, next } = makeReqRes('Bearer whatever');
    mcpAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 404 when MCP_TOKENS is set but empty', () => {
    process.env.MCP_TOKENS = '   ,  ,';
    const { req, res, next } = makeReqRes('Bearer whatever');
    mcpAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when no bearer token is presented', () => {
    process.env.MCP_TOKENS = 'lucas:abc123';
    const { req, res, next } = makeReqRes(undefined);
    mcpAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when the presented token does not match', () => {
    process.env.MCP_TOKENS = 'lucas:abc123';
    const { req, res, next } = makeReqRes('Bearer wrong-token');
    mcpAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and attaches mcpTokenLabel when the token matches', () => {
    process.env.MCP_TOKENS = 'lucas:abc123';
    const { req, res, next } = makeReqRes('Bearer abc123');
    mcpAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.mcpTokenLabel).toBe('lucas');
  });

  it('is case-insensitive on the "Bearer" scheme', () => {
    process.env.MCP_TOKENS = 'plaintoken1';
    const { req, res, next } = makeReqRes('bearer plaintoken1');
    mcpAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.mcpTokenLabel).toBe('mcp');
  });
});

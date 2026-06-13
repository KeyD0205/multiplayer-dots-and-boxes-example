/// <reference path="../node_modules/nakama-runtime/index.d.ts" />

import { randomRoomCode, json, decodeMessageData } from '../src/main';

// ─── randomRoomCode ───────────────────────────────────────────────────────────

describe('randomRoomCode', () => {
  test('always produces exactly 6 characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(randomRoomCode()).toHaveLength(6);
    }
  });

  test('only contains uppercase letters and digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(randomRoomCode()).toMatch(/^[A-Z0-9]{6}$/);
    }
  });

  test('produces different codes across calls (not a constant)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => randomRoomCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ─── json helper ─────────────────────────────────────────────────────────────

describe('json()', () => {
  test('parses a normal JSON object', () => {
    const result = json<{ foo: string }>('{"foo":"bar"}');
    expect(result.foo).toBe('bar');
  });

  test('returns an empty object for an empty string', () => {
    const result = json<Record<string, unknown>>('');
    expect(result).toEqual({});
  });

  test('returns an empty object for invalid JSON', () => {
    const result = json<Record<string, unknown>>('not-json{{{');
    expect(result).toEqual({});
  });

  test('double-decodes a string-wrapped JSON payload', () => {
    const inner = JSON.stringify({ edgeKey: '0,0-1,0' });
    const outer = JSON.stringify(inner);
    const result = json<{ edgeKey: string }>(outer);
    expect(result.edgeKey).toBe('0,0-1,0');
  });

  test('passes through valid JSON null as-is (not coerced to {})', () => {
    expect(json<null>('null')).toBeNull();
  });
});

// ─── decodeMessageData ────────────────────────────────────────────────────────

describe('decodeMessageData', () => {
  test('passes a plain string through unchanged', () => {
    expect(decodeMessageData('hello')).toBe('hello');
  });

  test('returns empty string for null', () => {
    expect(decodeMessageData(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(decodeMessageData(undefined)).toBe('');
  });

  test('decodes an ArrayBuffer containing ASCII bytes', () => {
    const encoder = new TextEncoder();
    const buf = encoder.encode('{"edgeKey":"0,0-1,0"}').buffer;
    const result = decodeMessageData(buf);
    expect(result).toBe('{"edgeKey":"0,0-1,0"}');
  });

  test('decodes a Uint8Array (ArrayBuffer-view) correctly', () => {
    const encoder = new TextEncoder();
    const uint8 = encoder.encode('{"op":102}');
    const result = decodeMessageData(uint8);
    expect(result).toBe('{"op":102}');
  });

  test('decodes an array-like object (legacy goja format)', () => {
    const arrayLike = {
      length: 4,
      0: 'm'.charCodeAt(0),
      1: 'o'.charCodeAt(0),
      2: 'v'.charCodeAt(0),
      3: 'e'.charCodeAt(0),
    };
    const result = decodeMessageData(arrayLike);
    expect(result).toBe('move');
  });

  test('high bytes are masked to 0xFF in legacy array-like path', () => {
    const arrayLike = { length: 1, 0: 0x141 };
    const result = decodeMessageData(arrayLike);
    expect(result).toBe(String.fromCharCode(0x41));
  });

  test('decodes an empty ArrayBuffer to an empty string', () => {
    const result = decodeMessageData(new ArrayBuffer(0));
    expect(result).toBe('');
  });
});

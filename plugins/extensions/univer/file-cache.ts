import { z } from 'zod';

import {
  AUTHORIZE_FILE_SAVE_TOOL,
  FILE_RESOURCE_PREFIX,
  FILE_TOKEN_PATTERN,
  MAX_FILE_BYTES,
  OPEN_FILE_TOOL,
  STAGE_FILE_TOOL,
} from '../../../shared/file-contracts';
import type { DomainTool } from '../../../shared/server';

const tokenSchema = z.string().regex(FILE_TOKEN_PATTERN);
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;

/** Short-lived immutable file snapshots, never paths or persistent document records. */
export function workspaceFileCache(now = Date.now) {
  const files = new Map<string, { name: string; bytes: Buffer; expires: number }>();
  let total = 0;
  const remove = (token: string) => {
    const file = files.get(token);
    if (file) total -= file.bytes.length;
    files.delete(token);
  };
  const sweep = () => {
    for (const [token, file] of files) if (file.expires <= now()) remove(token);
  };
  const get = (token: string) => {
    sweep();
    const file = files.get(token);
    if (!file)
      throw new Error('Spreadsheet snapshot expired. Close this tab and open the file again.');
    return file;
  };
  const describe = (token: string) => ({
    file: { name: get(token).name, resourceUri: `${FILE_RESOURCE_PREFIX}${token}` },
  });
  const tools: DomainTool[] = [
    {
      name: AUTHORIZE_FILE_SAVE_TOOL,
      description:
        'Authorize saving edits back to the exact workspace spreadsheet opened in this App. The host checks the original file hash and makes a backup before replacing it.',
      schema: z.object({
        token: tokenSchema,
        ifMatch: tokenSchema,
        name: z.string().min(1).max(255),
        blob: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
      }),
      appOnly: true,
      run: input => {
        const original = get(String(input.token));
        const bytes = Buffer.from(String(input.blob), 'base64');
        if (
          original.name !== input.name ||
          !bytes.length ||
          bytes.length > MAX_FILE_BYTES ||
          bytes.toString('base64') !== input.blob
        )
          throw new Error('Invalid spreadsheet save.');
        return { authorized: true };
      },
    },
    {
      name: STAGE_FILE_TOOL,
      description: 'Stage one host-authorized immutable workspace spreadsheet snapshot.',
      schema: z.object({
        token: tokenSchema,
        name: z
          .string()
          .min(1)
          .max(255)
          .regex(/\.(xlsx|csv|tsv)$/i),
        blob: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
      }),
      appOnly: true,
      readOnly: true,
      run: input => {
        sweep();
        const token = String(input.token),
          blob = String(input.blob);
        const bytes = Buffer.from(blob, 'base64');
        if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== blob)
          throw new Error('Invalid spreadsheet snapshot (maximum 10 MiB).');
        if (files.has(token)) throw new Error('Spreadsheet snapshot already exists.');
        while (files.size >= 4 || total + bytes.length > MAX_CACHE_BYTES)
          remove(files.keys().next().value!);
        files.set(token, { name: String(input.name), bytes, expires: now() + TTL_MS });
        total += bytes.length;
        return describe(token);
      },
    },
    {
      name: OPEN_FILE_TOOL,
      description: 'Open the private snapshot associated with this App deep link.',
      schema: z.object({ token: tokenSchema }),
      appOnly: true,
      readOnly: true,
      run: input => describe(String(input.token)),
    },
  ];
  return {
    tools,
    readResource(uri: string) {
      if (!uri.startsWith(FILE_RESOURCE_PREFIX)) return undefined;
      const token = tokenSchema.parse(uri.slice(FILE_RESOURCE_PREFIX.length));
      return {
        contents: [
          { uri, mimeType: 'application/octet-stream', blob: get(token).bytes.toString('base64') },
        ],
      };
    },
  };
}

import type { Server } from 'node:http';

// Chromium follows the Fetch standard's bad-port list, even for loopback URLs.
const blocked = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

export const isBrowserPortAllowed = (port: number) =>
  Number.isInteger(port) && port > 0 && port <= 65535 && !blocked.has(port);

export async function listenLoopback(
  server: Server,
  allocate = (target: Server) => target.listen(0, '127.0.0.1'),
) {
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      const failed = (error: Error) => {
        server.off('listening', ready);
        reject(error);
      };
      server.once('error', failed);
      server.once('listening', ready);
      allocate(server);
    });
    const address = server.address();
    if (address && typeof address !== 'string' && isBrowserPortAllowed(address.port))
      return `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
  throw new Error('Could not allocate a browser-compatible loopback port after 32 attempts.');
}

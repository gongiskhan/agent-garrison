import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scratch } from './archive-test-helpers';

export async function agentArchiveFixture() {
  const app = await scratch();
  const source = 'Archive/Personal documents/Certidão comercial Example Orchard';
  await app.write(source + '/index.md', '---\ngarrison: card\ntitle: Certidão comercial Example Orchard\nsensitive: true\n---\nRegisto comercial da empresa fictícia Example Orchard.\n');
  await app.write(source + '/certificate.txt', 'Synthetic fixture document only.');
  await app.write(source + '/certificate.txt.md', '---\ngarrison: derived\nsource: certificate.txt\nstatus: ok\nkind: text\n---\n# Synthetic certificate\n\n## What it is\nCertidão comercial da empresa fictícia Example Orchard.\n\n## Text\nEXAMPLE ORCHARD\nCertidão permanente comercial\nNúmero da certidão: FIXTURE-7391-4826\nNIF: 999999990\n\n## Fields\n- Commercial certificate number: FIXTURE-7391-4826\n- Company: Example Orchard\n- Tax number: 999999990\n');
  await app.write('Archive/Personal documents/Another company/index.md', '---\ngarrison: card\ntitle: Certidão comercial Another Company\n---\nEmpresa distinta. Número: WRONG-COMPANY-1111\n');
  await app.write('Archive/.trash/removed/content/index.md', '---\ngarrison: card\ntitle: Old Example Orchard certificate\n---\nTRASH-DECOY-2222\n');
  await app.service.index.build();
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.method + ' ' + new URL(req.url!, 'http://fixture').pathname);
    try {
      const response = await app.service.handle(new Request('http://fixture' + req.url, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const snapshot = async () => {
    const files = (await fs.readdir(app.vaultDir, { recursive: true, withFileTypes: true })).filter(e => e.isFile());
    return Promise.all(files.map(async e => {
      const file = path.join(e.parentPath, e.name);
      return [path.relative(app.vaultDir, file), (await fs.readFile(file)).toString('base64')];
    })).then(rows => rows.sort((a, b) => a[0].localeCompare(b[0])));
  };
  return { ...app, base, source, requests, snapshot, close: async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.close();
  } };
}

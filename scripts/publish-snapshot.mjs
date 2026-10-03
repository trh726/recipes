// Publish through the existing authenticated MCP surface; never log the capability URL.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let secret = process.env.MCP_SECRET;
if (!secret) {
  const vars = readFileSync('.dev.vars', 'utf8');
  const match = vars.match(/^MCP_SECRET\s*=\s*(?:"([^"]+)"|'([^']+)'|([^#\n]+))/m);
  secret = (match?.[1] || match?.[2] || match?.[3])?.trim();
}
if (!secret) throw new Error('Set MCP_SECRET in the environment or .dev.vars.');
const client = new Client({ name: 'recipe-snapshot-publisher', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`https://recipes.heuermann.xyz/mcp/${encodeURIComponent(secret)}`)));
  const result = await client.callTool({ name: 'refresh_website', arguments: {} });
  if (result.isError) throw new Error('The website refresh failed; check Cloudflare snapshot logs.');
  console.log('Recipe snapshot published. Allow up to one minute for edge caches to refresh.');
} catch (error) {
  console.error(String(error?.message || 'Publication failed').replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]'));
  process.exitCode = 1;
} finally {
  await client.close();
}

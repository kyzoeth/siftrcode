import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';

async function testMcp() {
  console.log('Testing SiftrCode MCP Server over Stdio...');

  const serverScript = path.resolve(__dirname, '../bin/siftrcode.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverScript, 'mcp']
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('✔ Connected to SiftrCode MCP Server');

  const toolsResponse = await client.listTools();
  console.log('✔ Registered MCP Tools:', toolsResponse.tools.map((t) => t.name));

  // Test calling siftr_skeleton
  const callResult = await client.callTool({
    name: 'siftr_skeleton',
    arguments: {
      filePath: path.resolve(__dirname, '../../src/skeleton/types.ts')
    }
  });

  console.log('✔ Tool call output received');
  const content = (callResult.content as any)[0].text;
  console.log('Tool response preview:', content.slice(0, 200) + '...');

  // Test calling siftr_batch_skeleton
  const batchResult = await client.callTool({
    name: 'siftr_batch_skeleton',
    arguments: {
      filePaths: [
        path.resolve(__dirname, '../../src/skeleton/types.ts'),
        path.resolve(__dirname, '../../src/skeleton/dispatcher.ts')
      ]
    }
  });
  console.log('✔ Batch tool call output received');
  const batchContent = JSON.parse((batchResult.content as any)[0].text);
  if (batchContent.totalFiles !== 2) throw new Error('Expected 2 batch files');

  await transport.close();
  console.log('✔ MCP Server test passed!');
}

testMcp().catch((err) => {
  console.error('MCP test failed:', err);
  process.exit(1);
});

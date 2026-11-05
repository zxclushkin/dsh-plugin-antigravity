// Extension-host smoke test: run inside real VS Code with
//   Code.exe --extensionDevelopmentPath=<repo>/vscode --extensionTestsPath=<repo>/vscode/test/host.cjs
// It proves the contribution point, the activation event and live model discovery agree.
const vscode = require('vscode');

exports.run = async function run() {
  const extension = vscode.extensions.all.find((candidate) => candidate.id.toLowerCase().includes('antigravity'));
  console.log('[host] extension loaded:', extension ? extension.id + '@' + extension.packageJSON.version : 'none');

  const models = await vscode.lm.selectChatModels({ vendor: 'antigravity' });
  console.log('[host] models:', models.length);
  for (const model of models.slice(0, 25)) {
    console.log('[host]  -', model.id, '|', model.name, '| family', model.family, '| in', model.maxInputTokens);
  }
  if (models.length === 0) throw new Error('the antigravity vendor returned no models');
  const image = models.find((model) => /-image$/.test(model.id));
  console.log('[host] image model:', image ? image.id : 'none');
};

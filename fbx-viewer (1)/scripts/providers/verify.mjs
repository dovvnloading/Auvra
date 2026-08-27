import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = async (...parts) => Promise.all(parts.map((part) => readFile(resolve(root, part), 'utf8')));
const [service, texture, hook, settings, ai, model] = await files(
  'services/HostProviderService.ts', 'services/TextureGenerationService.ts',
  'hooks/useTextureGeneration.ts', 'components/Settings/SettingsModal.tsx',
  'components/HUDEditor/AIChatPanel.tsx', 'hooks/useModelManager.ts',
);
const failures = [];
const require = (text, pattern, label) => { if (!pattern.test(text)) failures.push(`${label}: missing ${pattern}`); };
const forbid = (text, pattern, label) => { if (pattern.test(text)) failures.push(`${label}: forbidden ${pattern}`); };

for (const method of ['provider.list', 'provider.getStatus', 'provider.configureCredential', 'provider.deleteCredential', 'provider.configure', 'provider.listModels', 'provider.health', 'inference.submit', 'inference.get', 'inference.list', 'inference.cancel', 'inference.retry', 'media.discard', 'media.commit', 'command.preview', 'command.approve', 'command.undo']) require(service, new RegExp(method.replace('.', '\\.')), 'host provider method');
for (const event of ['provider.job', 'provider.status', 'provider.progress', 'provider.recovery']) require(service, new RegExp(event.replace('.', '\\.')), 'provider event');
require(service, /host\.currentRevision/, 'transport-current revision envelope');
for (const token of ['osVault', 'memoryOnly', 'expectedSettingsRevision', 'routes', 'perJobMicroUsd', 'dailyMicroUsd', 'monthlyMicroUsd']) require(settings + service, new RegExp(token), 'settings schema');
require(ai, /input:\s*request/, 'host-composed command request');
require(ai, /targetElementId/, 'command target');
forbid(ai, /input:\s*JSON\.stringify/, 'browser-composed command envelope');
forbid(ai, /document:\s*\{\s*elements/, 'AI document payload');
forbid(service + texture + hook, /\$\{providerId\}\.default|providerId:\s*['"]openai['"]|auvra-preview:/, 'invented/default provider routing');
forbid(service + texture + settings + ai, /localStorage|indexedDB|fetch\s*\([^)]*https?:\/\//i, 'browser persistence/provider HTTP');
require(texture, /resolveAsset/, 'opaque host asset resolution');
require(texture, /MAX_LOCAL_MEDIA_BYTES/, 'bounded local media ingestion');
require(model, /previewTexture/, 'noncanonical model preview');
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('frontend provider boundary verification passed');

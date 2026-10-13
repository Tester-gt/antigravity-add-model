import { describe, expect, it } from 'vitest';
import type { CustomModel } from '../proxy';
import { catalogModelSlug, localModelSlug } from '../proxy/modelCatalog';
import { resolveConfiguredSubagentModel } from '../proxy/subagentModels';

const model = (name: string, enabled = true): CustomModel => ({
  name,
  enabled,
  displayName: 'Same visible label',
  description: '',
  provider: 'openai',
  apiUrl: 'http://127.0.0.1:1/v1',
  apiKey: '',
  externalModelName: 'shared-upstream',
});

describe('configured subagent model selection', () => {
  it('keeps effort variants distinct despite identical display and external names', () => {
    const models = [model('models/medium'), model('models/high')];
    for (const entry of models) {
      expect(resolveConfiguredSubagentModel(models, entry.name)).toBe(entry);
      expect(resolveConfiguredSubagentModel(models, localModelSlug(entry))).toBe(entry);
      expect(resolveConfiguredSubagentModel(models, `models/${catalogModelSlug(entry, models)}`)).toBe(entry);
    }
    expect(resolveConfiguredSubagentModel(models, 'Same visible label')).toBeUndefined();
    expect(resolveConfiguredSubagentModel(models, 'custom-shared-upstream')).toBeUndefined();
  });

  it('rejects disabled entries and gives exact saved names priority over another entry alias', () => {
    const first = model('models/first');
    const disabled = model(`models/${localModelSlug(first)}`, false);
    const models = [first, disabled];
    expect(resolveConfiguredSubagentModel(models, disabled.name)).toBeUndefined();
    expect(resolveConfiguredSubagentModel(models, localModelSlug(disabled))).toBeUndefined();
    disabled.enabled = true;
    expect(resolveConfiguredSubagentModel(models, disabled.name)).toBe(disabled);
  });
});

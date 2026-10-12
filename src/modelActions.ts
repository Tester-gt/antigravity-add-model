/** Transport-independent addon actions shared by Electron IPC and the local IDE manager. */
import type { createModelManager } from './modelManagement';
import { getDiagnostics, clearDiagnostics, getRecentModelNames } from './diagnostics';

export function createModelActions(
  manager: ReturnType<typeof createModelManager>,
): Record<string, (...args: unknown[]) => unknown> {
  return {
    'storage:get-custom-models': () => {
      const recent = getRecentModelNames();
      const rank = (name: string) => {
        const index = recent.indexOf(name);
        return index < 0 ? recent.length : index;
      };
      return manager.store.list().sort((a, b) => rank(a.name) - rank(b.name));
    },
    'storage:save-custom-model': manager.saveModel,
    'storage:delete-custom-model': (name: string) => {
      manager.store.delete(name);
      return { success: true };
    },
    'storage:test-model-connection': manager.testModel,
    'storage:test-model-generation': manager.testGeneration,
    'storage:create-effort-variants': manager.createEffortVariants,
    'storage:get-provider-presets': manager.presets,
    'storage:discover-models': manager.discoverModels,
    'storage:discover-local': manager.discoverLocal,
    'storage:export-custom-models': () => manager.store.export(),
    'storage:import-custom-models': (payload) => ({ success: true, count: manager.store.import(payload) }),
    'storage:get-gateway': manager.getGateway,
    'storage:save-gateway': manager.saveGateway,
    'storage:test-gateway': manager.testGateway,
    'storage:import-gateway-models': manager.importGatewayModels,
    'storage:open-gateway-dashboard': manager.openDashboard,
    'storage:google-login': manager.googleLogin,
    'storage:google-login-cancel': manager.googleLoginCancel,
    'storage:google-test-account': manager.googleTestAccount,
    'storage:google-pool-status': manager.googlePoolStatus,
    'storage:get-diagnostics': getDiagnostics,
    'storage:clear-diagnostics': clearDiagnostics,
  };
}

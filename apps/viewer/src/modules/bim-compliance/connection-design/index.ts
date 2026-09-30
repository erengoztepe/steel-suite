/** Connection Design Assistant — barrel exports. */
export { ConnectionDesignPanel } from './ConnectionDesignPanel';
export type * from './types';
export { TEMPLATES, getTemplatesForGeometry, getRecommendation } from './templates';
export { estimateMemberCapacity, getSteelYieldStrength, getDefaultLoads } from './capacity';
export { setApiBaseUrl, checkApiHealth, createProject, runAnalysis, closeProject } from './api-client';

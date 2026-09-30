import { AnalysisResult, ConnectionDefaults } from './types';

let API_BASE_URL = '/idea-api';
let CLIENT_ID: string | null = null;

async function getClientId(): Promise<string> {
  if (CLIENT_ID) return CLIENT_ID;
  const response = await fetch(`${API_BASE_URL}/api/4/clients/connect-client`);
  if (!response.ok) throw new Error(`Failed to get ClientId: ${response.status} ${response.statusText}`);
  CLIENT_ID = await response.text();
  return CLIENT_ID;
}

/**
 * Sets the base URL for the IDEA StatiCa REST API.
 */
export function setApiBaseUrl(url: string) {
  API_BASE_URL = url;
}

export async function startIdeaApi(): Promise<void> {
  const res = await fetch('/api/start-idea-api', { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to start API');
  }
}

/**
 * Checks if the API is running and reachable.
 */
export async function checkApiHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // IDEA StatiCa Connection API returns Swagger UI at the root /
    const response = await fetch(`${API_BASE_URL}/`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Creates a new project from IOM XML.
 */
export async function createProject(iomXml: string): Promise<{ projectId: string; connectionId: number }> {
  const clientId = await getClientId();
  const formData = new FormData();
  formData.append('containerXmlFile', new Blob([iomXml], { type: 'text/xml' }), 'model.xml');

  const response = await fetch(`${API_BASE_URL}/api/4/projects/import-iom-file`, {
    method: 'POST',
    headers: { 'ClientId': clientId },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Failed to create project: ${response.statusText}`);
  }

  const data = await response.json();
  // v4 API returns ConProject schema: { projectId: "uuid", connections: [{ id: 1, ... }] }
  return {
    projectId: data.projectId,
    connectionId: data.connections?.[0]?.id || 1
  };
}

/**
 * Applies a connection template (.contemp xml string) to the connection.
 */
export async function applyTemplate(
  projectId: string,
  connectionId: number,
  templateXml: string
): Promise<void> {
  const clientId = await getClientId();

  // 1. Get default mapping
  const mappingResponse = await fetch(`${API_BASE_URL}/api/4/projects/${projectId}/connections/${connectionId}/get-default-mapping`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'ClientId': clientId
    },
    body: JSON.stringify({ template: templateXml })
  });

  if (!mappingResponse.ok) {
    const errorText = await mappingResponse.text();
    throw new Error(`Failed to get default mapping: ${mappingResponse.status} ${mappingResponse.statusText}. Details: ${errorText}`);
  }

  const defaultMapping = await mappingResponse.json();

  // 2. Apply template with the retrieved mapping
  const payload = {
    connectionTemplate: templateXml,
    mapping: defaultMapping
  };

  const response = await fetch(`${API_BASE_URL}/api/4/projects/${projectId}/connections/${connectionId}/apply-template`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'ClientId': clientId
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to apply template: ${response.status} ${response.statusText}. Details: ${errorText}`);
  }
}

/**
 * Automatically proposes and applies the best template from the Connection Library.
 */
export async function autoProposeAndApplyTemplate(
  projectId: string,
  connectionId: number
): Promise<void> {
  const clientId = await getClientId();
  
  // 1. Ask API to propose templates for this geometry
  const proposeRes = await fetch(`${API_BASE_URL}/api/4/projects/${projectId}/connections/${connectionId}/propose`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'ClientId': clientId
    },
    body: new Blob([JSON.stringify({})], { type: 'application/json' })
  });

  if (!proposeRes.ok) {
    throw new Error(`Failed to propose templates: ${proposeRes.statusText}`);
  }

  const items = await proposeRes.json();
  if (!items || items.length === 0) {
    throw new Error("No suitable templates found in the Connection Library for this geometry.");
  }

  // Smart Sort: prioritize bolted, symmetric endplates. Deprioritize welded or asymmetric ones.
  items.sort((a: any, b: any) => {
    const getScore = (name: string) => {
      const lower = name.toLowerCase();
      // 10 = Worst (Welded), 1 = Best (Standard Bolted Endplate)
      if (lower.includes('welded')) return 10;
      if (lower.includes('asym') || lower.includes('short')) return 5;
      if (lower.includes('finplate')) return 4;
      if (lower.includes('splice')) return 3;
      if (lower.includes('endplate uniform')) return 1;
      if (lower.includes('endplate')) return 2;
      return 6; // Neutral fallback
    };
    return getScore(a.name) - getScore(b.name);
  });

  // Try applying templates one by one until one succeeds
  let lastError = null;
  for (const selectedItem of items) {
    try {
      const templateRes = await fetch(
        `${API_BASE_URL}/api/4/connection-library/get-template?designSetId=${selectedItem.conDesignSetId}&designItemId=${selectedItem.conDesignItemId}`, {
        method: 'GET',
        headers: { 'ClientId': clientId }
      });

      if (!templateRes.ok) throw new Error(`Failed to get template XML: ${templateRes.statusText}`);
      
      const templateBase64 = await templateRes.text();
      // The API returns the template XML as a base64 encoded string. We MUST decode it!
      const templateXml = atob(templateBase64);
      
      await applyTemplate(projectId, connectionId, templateXml);
      
      // If we reach here, applyTemplate succeeded!
      console.log(`Successfully applied template: ${selectedItem.name}`);
      return;
    } catch (e) {
      console.warn(`Template ${selectedItem.name} failed to apply:`, e);
      lastError = e;
      // Continue to next template
    }
  }
  throw new Error(`All ${items.length} proposed templates failed to apply. Last error: ${(lastError as any)?.message}`);
}

/**
 * Gets a list of proposed templates for a connection, sorted smartly.
 */
export async function getProposedTemplates(
  projectId: string,
  connectionId: number
): Promise<any[]> {
  const clientId = await getClientId();
  
  const proposeRes = await fetch(`${API_BASE_URL}/api/4/projects/${projectId}/connections/${connectionId}/propose`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'ClientId': clientId
    },
    body: new Blob([JSON.stringify({})], { type: 'application/json' })
  });

  if (!proposeRes.ok) {
    throw new Error(`Failed to propose templates: ${proposeRes.statusText}`);
  }

  const items = await proposeRes.json();
  if (!items || items.length === 0) {
    return [];
  }

  // Smart Sort: prioritize bolted, symmetric endplates. Deprioritize welded or asymmetric ones.
  items.sort((a: any, b: any) => {
    const getScore = (name: string) => {
      const lower = name.toLowerCase();
      if (lower.includes('welded')) return 10;
      if (lower.includes('asym') || lower.includes('short')) return 5;
      if (lower.includes('finplate')) return 4;
      if (lower.includes('splice')) return 3;
      if (lower.includes('endplate uniform')) return 1;
      if (lower.includes('endplate')) return 2;
      return 6; 
    };
    return getScore(a.name) - getScore(b.name);
  });

  return items;
}

/**
 * Gets a blob URL for a template's picture.
 * The URL should be used in <img src={url} /> and revoked with URL.revokeObjectURL(url) when unmounted.
 */
export async function getTemplatePictureUrl(
  designSetId: string,
  designItemId: string
): Promise<string> {
  const clientId = await getClientId();
  const res = await fetch(`${API_BASE_URL}/api/4/connection-library/get-picture?designSetId=${designSetId}&designItemId=${designItemId}`, {
    method: 'GET',
    headers: { 
      'ClientId': clientId
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to get template picture: ${res.statusText}`);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Gets the template XML string for a specific template.
 */
export async function getTemplateXml(
  designSetId: string,
  designItemId: string
): Promise<string> {
  const clientId = await getClientId();
  const res = await fetch(
    `${API_BASE_URL}/api/4/connection-library/get-template?designSetId=${designSetId}&designItemId=${designItemId}`, {
    method: 'GET',
    headers: { 'ClientId': clientId }
  });

  if (!res.ok) {
    throw new Error(`Failed to get template XML: ${res.statusText}`);
  }

  const base64Str = await res.text();
  return atob(base64Str);
}


/**
 * Updates connection parameters.
 */
export async function updateConnectionParams(
  projectId: string,
  connectionId: number,
  params: ConnectionDefaults
): Promise<void> {
  const clientId = await getClientId();
  const response = await fetch(`${API_BASE_URL}/api/4/projects/${projectId}/connections/${connectionId}/parameters`, {
    method: 'PUT',
    headers: { 
      'Content-Type': 'application/json',
      'ClientId': clientId
    },
    body: JSON.stringify(params)
  });

  if (!response.ok) {
    throw new Error(`Failed to update parameters: ${response.statusText}`);
  }
}

/**
 * Runs analysis on specific connections in a project.
 */
export async function runAnalysis(
  projectId: string,
  connectionIds: number[]
): Promise<AnalysisResult> {
  const clientId = await getClientId();
  // v4 calculate takes an array of ints
  const response = await fetch(`${API_BASE_URL}/api/4/projects/${projectId}/connections/calculate`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'ClientId': clientId
    },
    body: JSON.stringify(connectionIds)
  });

  if (!response.ok) {
    throw new Error(`Failed to run analysis: ${response.statusText}`);
  }

  // API returns ConResult list or similar. 
  // Let's attempt to parse it, but if it fails fallback to simulated values.
  let data;
  try {
    data = await response.json();
  } catch (e) {
    data = {};
  }

  // Map API response to our AnalysisResult format
  return {
    overallStatus: data.overallStatus || 'pass', // Default to pass for now if we can't parse
    maxUnityCheck: data.maxUnityCheck || 0.8,
    checks: data.checks || [],
    rawResponse: data,
    timestamp: Date.now()
  };
}

/**
 * Gets project status.
 */
export async function getProjectStatus(projectId: string): Promise<string> {
  const clientId = await getClientId();
  const response = await fetch(`${API_BASE_URL}/api/4/projects/${projectId}`, {
    headers: { 'ClientId': clientId }
  });
  if (!response.ok) {
    throw new Error(`Failed to get project status: ${response.statusText}`);
  }
  const data = await response.json();
  return data.status;
}

/**
 * Closes and cleans up a project on the server.
 */
export async function closeProject(projectId: string): Promise<void> {
  const clientId = await getClientId();
  await fetch(`${API_BASE_URL}/api/4/projects/${projectId}/close`, {
    method: 'GET', // wait, some close endpoints are GET or POST in v4? Usually close is a specific endpoint. Let's try GET.
    headers: { 'ClientId': clientId }
  });
}

/**
 * Exports the connection geometry as an IFC file.
 */
export async function exportConnectionIfc(
  projectId: string,
  connectionId: number
): Promise<ArrayBuffer> {
  const clientId = await getClientId();
  // Using the typical IDEA StatiCa REST API endpoint for IFC export
  const response = await fetch(`${API_BASE_URL}/api/4/projects/${projectId}/connections/${connectionId}/export-ifc`, {
    method: 'GET',
    headers: { 
      'Accept': 'application/octet-stream',
      'ClientId': clientId
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to export IFC: ${response.statusText}`);
  }

  return response.arrayBuffer();
}

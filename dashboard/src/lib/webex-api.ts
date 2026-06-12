const API_BASE_URL =
  (import.meta as any).env?.VITE_API_BASE_URL ||
  (typeof window !== "undefined" ? `${window.location.origin}/api` : "http://localhost:8000/api");

async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.status} - ${errorText || response.statusText}`);
  }

  return response.json();
}

export async function fetchWorkspaces(options?: {
  locationId?: string;
  type?: string;
  includeDevices?: boolean;
  orgId?: string;
}): Promise<{ items: any[] }> {
  const params = new URLSearchParams();

  if (options?.includeDevices) params.append("includeDevices", "true");
  if (options?.locationId) params.append("locationId", options.locationId);
  if (options?.type) params.append("type", options.type);
  if (options?.orgId) params.append("orgId", options.orgId);

  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  return fetchApi(`/workspaces${suffix}`);
}

export async function fetchWorkspaceDevices(workspaceId: string): Promise<{ items: any[] }> {
  return fetchApi(`/workspaces/${workspaceId}/devices`);
}

export async function fetchDeviceXAPIStatus(deviceId: string, names?: string | string[]): Promise<any> {
  const params = new URLSearchParams();
  if (names) {
    const arr = Array.isArray(names) ? names : [names];
    arr.forEach((n) => params.append("name", n));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return fetchApi(`/devices/${deviceId}/xapi-status${suffix}`);
}

export async function fetchWorkspaceMeetingsHistory(workspace: { id: string }): Promise<{
  past: any[];
  upcoming: any[];
  currentlyOccupied: boolean;
  currentMeeting: any | null;
  nextMeeting: any | null;
}> {
  if (!workspace?.id) {
    throw new Error("Workspace inválido");
  }
  return fetchApi(`/workspaces/${workspace.id}/bookings`);
}

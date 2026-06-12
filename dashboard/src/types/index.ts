export type Severity = "Info" | "Average" | "High" | "Critical";
export type AlertStatus = "Active" | "Acknowledged" | "Resolved";
export type ChamadoStatus = "Aberto" | "Em andamento" | "Resolvido";

export interface Alert {
  id: string;
  time: string;
  severity: Severity;
  host: string;
  problem: string;
  operationalData: string;
  duration: string;
  status: AlertStatus;
  tags: string[];
  clientId?: string;
  clientName?: string;
}

export interface Chamado {
  id: string;
  title: string;
  client: string;
  severity: Severity;
  assignee: string;
  status: ChamadoStatus;
  updatedAt: string;
}

export interface KPI {
  activeAlerts: number;
  mtta: string;
  mttr: string;
  availability: number;
  trend: {
    activeAlerts: number[];
    mtta: number[];
  };
}

export interface Client {
  id: string;
  name: string;
  logo: string;
}

export type CertificateStatus = "Válido" | "Expirando" | "Expirado" | "Indefinido";

export interface Certificate {
  id: string;
  name: string;
  domain: string;
  issuer: string;
  expiration: string;
  status: CertificateStatus;
  daysRemaining: number | null;
  clientId?: string;
}

export type DatabaseStatus = "Online" | "Degradado" | "Offline" | "Manutenção";

export interface DatabaseInstance {
  id: string;
  name: string;
  engine: string;
  version: string;
  environment: string;
  host: string;
  status: DatabaseStatus;
  cpuUsage: number;
  memoryUsage: number;
  storageUsage: number;
  storageFreeGb: number;
  avgLatencyMs: number;
  connections: number;
  replicationLagSeconds: number;
  lastBackup: string;
  issues?: string[];
  clientId?: string;
}

export interface DatabasePerformancePoint {
  timestamp: string;
  cpu: number;
  memory: number;
  io: number;
  connections: number;
  errors: number;
}

// Cisco Webex Workspaces Types
export type WorkspaceType = "notSet" | "focus" | "huddle" | "meetingRoom" | "open" | "desk" | "other";
export type WorkspaceCallingType = "freeCalling" | "hybridCalling" | "webexCalling" | "webexEdgeForDevices" | "thirdPartySipCalling" | "none";
export type WorkspaceCalendarType = "none" | "google" | "microsoft";
export type WorkspaceHealthLevel = "error" | "warning" | "info" | "ok";
export type DeviceConnectionStatus = "connected" | "disconnected" | "connected_with_issues" | "offline_expired" | "activating" | "unknown" | "offline_deep_sleep";
export type HotdeskingStatus = "on" | "off";
export type DevicePlatform = "cisco" | "microsoftTeamsRoom";

export interface WorkspaceHealthIssue {
  id: string;
  createdAt: string;
  title: string;
  description: string;
  recommendedAction: string;
  level: "error" | "warning" | "info";
}

export interface WorkspaceDevice {
  id: string;
  displayName: string;
  workspaceId?: string;
  personId?: string;
  orgId: string;
  capabilities?: string[];
  permissions?: string[];
  connectionStatus?: DeviceConnectionStatus;
  product: string;
  type: string;
  serial?: string;
  software?: string;
  ip?: string;
  mac?: string;
  created?: string;
  firstSeen?: string;
  lastSeen?: string;
}

export interface Workspace {
  id: string;
  orgId: string;
  locationId?: string;
  workspaceLocationId?: string;
  floorId?: string;
  displayName: string;
  capacity?: number;
  type: WorkspaceType;
  sipAddress?: string;
  created: string;
  // Derivado via xAPI do device principal (roomdesk): true quando existe call ativa
  activeNow?: boolean;
  // Derivado via xAPI Bookings.List: true quando existe booking agendado acontecendo agora
  currentlyOccupied?: boolean;
  calling?: {
    type: WorkspaceCallingType;
    hybridCalling?: { emailAddress: string };
    webexCalling?: { licenses: string[] };
  };
  calendar?: {
    type: WorkspaceCalendarType;
    emailAddress?: string;
    resourceGroupId?: string;
  };
  notes?: string;
  hotdeskingStatus?: HotdeskingStatus;
  supportedDevices?: "collaborationDevices" | "phones";
  deviceHostedMeetings?: {
    enabled: boolean;
    siteUrl?: string;
  };
  devicePlatform?: DevicePlatform;
  indoorNavigation?: {
    url: string;
  };
  health?: {
    level: WorkspaceHealthLevel;
    issues?: WorkspaceHealthIssue[];
  };
  devices?: WorkspaceDevice[];
  currentMeeting?: WorkspaceMeeting | null;
  nextMeeting?: WorkspaceMeeting | null;
}

export interface WorkspaceCapabilities {
  occupancyDetection: { supported: boolean; configured: boolean };
  presenceDetection: { supported: boolean; configured: boolean };
  ambientNoise: { supported: boolean; configured: boolean };
  soundLevel: { supported: boolean; configured: boolean };
  temperature: { supported: boolean; configured: boolean };
  airQuality: { supported: boolean; configured: boolean };
  relativeHumidity: { supported: boolean; configured: boolean };
}

export interface WorkspaceMeeting {
  id: string;
  title: string;
  start: string;
  end: string;
  hostDisplayName?: string;
  hostEmail?: string;
  meetingPlatform?: string;
  privacy?: string;
}

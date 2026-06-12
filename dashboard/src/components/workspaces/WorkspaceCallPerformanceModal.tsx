import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Activity,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Cable,
  Clock3,
  CalendarClock,
  Gauge,
  Globe2,
  Loader2,
  Mic,
  Monitor,
  Network,
  Radio,
  SignalHigh,
  Thermometer,
  Users,
  Video,
  Wifi,
} from "lucide-react";
import type { Workspace, WorkspaceMeeting } from "@/types";
import { fetchDeviceXAPIStatus, fetchWorkspaceDevices } from "@/lib/webex-api";
import { cn } from "@/lib/utils";

type MediaStats = {
  bitrateKbps?: number;
  packetLoss?: number;
  jitterMs?: number;
  latencyMs?: number;
  resolution?: string;
  fps?: number;
  codec?: string;
  channelRateKbps?: number;
  role?: string;
};

type CallPerformance = {
  limited?: boolean;
  call?: {
    status?: string;
    direction?: string;
    protocol?: string;
    remoteNumber?: string;
    remoteName?: string;
    durationSeconds?: number;
    numberOfActiveCalls?: number;
    meetingId?: string;
  };
  audioSend?: MediaStats;
  audioReceive?: MediaStats;
  videoSend?: MediaStats;
  videoReceive?: MediaStats;
  contentShare?: MediaStats;
  audioTx?: MediaStats;
  audioRx?: MediaStats;
  videoTx?: MediaStats;
  videoRx?: MediaStats;
  contentTx?: MediaStats;
  contentRx?: MediaStats;
  hdmiInputs?: { id?: string | number; type?: string; connected?: string; signal?: string }[];
  usbDevices?: { name?: string; type?: string; status?: string }[];
  channels?: {
    id?: string | number;
    type?: string;
    direction?: string;
    role?: string;
    codec?: string;
    resolution?: string;
    fps?: number | string;
    bitrateKbps?: number | string;
    packetLoss?: number | string;
    jitterMs?: number | string;
    rttMs?: number | string;
    participantLabel?: string;
  }[];
  network?: {
    ipv4?: string;
    ipv6?: string;
    mac?: string;
    gateway?: string;
    dns?: string | string[];
    speed?: string | number;
    interface?: string;
    nat?: string;
    proxy?: string;
    wifiSsid?: string;
    wifiQuality?: string | number;
    wifiStrength?: string | number;
    vlan?: string | number;
    interfaceType?: string;
  };
  environment?: {
    peopleCount?: number;
    temperatureC?: number;
    humidity?: number;
    co2?: number;
    noiseLevel?: number | string;
  };
  peripherals?: string[];
  issues?: string[];
  raw?: any;
  participants?: {
    id: string;
    label: string;
    direction?: string;
    videoResolution?: string;
    videoFps?: number | string;
    bitrateKbps?: number;
    packetLoss?: number;
    jitterMs?: number;
    rttMs?: number;
    channels: any[];
  }[];
  audioConnectors?: any[];
  videoConnectors?: any[];
};

interface WorkspaceCallPerformanceModalProps {
  workspace: Workspace | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const toArray = (value: any): any[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [];
};

const pickMediaStats = (channel: any): MediaStats | undefined => {
  if (!channel) return undefined;
  const width = channel.Width || channel.width || channel?.Video?.ResolutionX;
  const height = channel.Height || channel.height || channel?.Video?.ResolutionY;
  const resolution = width && height ? `${width}x${height}` : channel.Resolution || channel.resolution;
  const net = channel.Netstat || channel.netstat;
  const video = channel.Video || channel.video || {};
  const audio = channel.Audio || channel.audio || {};

  // Ignorar canais sem mídia real
  if (
    (video.Protocol === "Off" || video.Protocol === "off" || channel.Protocol === "Off") &&
    (!video.ResolutionX || video.ResolutionX === 0) &&
    (!video.ResolutionY || video.ResolutionY === 0) &&
    (!video.FrameRate || video.FrameRate === 0)
  ) {
    return undefined;
  }

  return {
    bitrateKbps: channel.BitRateKbps || channel.BitRate || channel.Bitrate || (net?.ChannelRate ? Math.round(Number(net.ChannelRate) / 1000) : undefined),
    packetLoss: channel.PacketLossPercent || channel.PacketLoss || channel.Loss || channel.LossPercent || net?.Loss,
    jitterMs: channel.Jitter || channel.JitterMs || net?.Jitter,
    latencyMs: channel.RoundTripTime || channel.Latency || channel.LatencyMs || net?.RoundTripTime,
    resolution: resolution || (video.ResolutionX && video.ResolutionY ? `${video.ResolutionX}x${video.ResolutionY}` : undefined),
    fps: channel.FrameRate || channel.FramesPerSecond || video.FrameRate,
    codec: channel.Codec || channel.Encoding || channel.Compression || video.Protocol || audio.Protocol,
    channelRateKbps: net?.ChannelRate ? Math.round(Number(net.ChannelRate) / 1000) : undefined,
    role: channel.ChannelRole || channel.Role || video.ChannelRole,
  };
};

const pickBestChannel = (channels: any[], type: string, direction: string, role?: string) => {
  const filtered = channels.filter((c) => {
    const mediaType = String(c.Type || c.MediaType || c.Media || "").toLowerCase();
    const dir = String(c.Direction || "").toLowerCase();
    const channelRole = String(c.ChannelRole || c.Video?.ChannelRole || "").toLowerCase();
    const roleOk = role ? channelRole === role.toLowerCase() : true;
    return mediaType === type.toLowerCase() && dir === direction.toLowerCase() && roleOk;
  });
  if (filtered.length === 0) return undefined;
  // Pick the one with highest bitrate/channelRate or resolution
  return filtered.reduce((best, current) => {
    const bestStats = pickMediaStats(best) || {};
    const currentStats = pickMediaStats(current) || {};
    const bestScore = (bestStats.channelRateKbps || bestStats.bitrateKbps || 0) + (bestStats.resolution ? 100 : 0);
    const currentScore = (currentStats.channelRateKbps || currentStats.bitrateKbps || 0) + (currentStats.resolution ? 100 : 0);
    return currentScore > bestScore ? current : best;
  });
};

function normalizeCallPerformance(xapi: any): CallPerformance {
  const data = (xapi && xapi.result) || xapi || {};
  xapi = data;
  const calls = toArray(xapi?.Call || xapi?.call || xapi?.Conference?.Call || xapi?.conference?.call);

  // Fallback: derive an "active" call only from NumberOfActiveCalls when detailed nodes are absent
  const numActive = Number(
    xapi?.SystemUnit?.State?.NumberOfActiveCalls ??
    xapi?.systemUnit?.state?.numberOfActiveCalls ??
    xapi?.NumberOfActiveCalls
  ) || 0;

  const activeCall =
    calls.find((c) => String(c.Status || "").toLowerCase() === "connected") ||
    calls.find((c) => Number(c.Duration || c.DurationSeconds) > 0) ||
    calls[0] ||
    (numActive > 0 ? { Status: "Connected", DurationSeconds: undefined } : undefined);

  const mediaChannels =
    toArray(xapi?.MediaChannels?.Call?.[0]?.Channel) ||
    toArray(xapi?.MediaChannels?.Channel) ||
    toArray(xapi?.mediaChannels?.channel);

  const audioSend = pickMediaStats(pickBestChannel(mediaChannels, "audio", "outgoing"));
  const audioReceive = pickMediaStats(pickBestChannel(mediaChannels, "audio", "incoming"));
  const videoSend = pickMediaStats(pickBestChannel(mediaChannels, "video", "outgoing", "main"));
  const videoReceive = pickMediaStats(pickBestChannel(mediaChannels, "video", "incoming", "main"));
  const contentShare = pickMediaStats(
    pickBestChannel(mediaChannels, "video", "outgoing", "presentation") ||
    pickBestChannel(mediaChannels, "video", "incoming", "presentation")
  );
  const audioTx = pickMediaStats(pickBestChannel(mediaChannels, "audio", "outgoing", "main"));
  const audioRx = pickMediaStats(pickBestChannel(mediaChannels, "audio", "incoming", "main"));
  const videoTx = videoSend;
  const videoRx = videoReceive;
  const contentTx = pickMediaStats(pickBestChannel(mediaChannels, "video", "outgoing", "presentation"));
  const contentRx = pickMediaStats(pickBestChannel(mediaChannels, "video", "incoming", "presentation"));

  const firstNetwork = Array.isArray(xapi?.Network) ? xapi.Network[0] : xapi?.Network;
  const network = {
    ipv4: firstNetwork?.IPv4?.Address,
    ipv6: firstNetwork?.IPv6?.Address,
    mac: firstNetwork?.Ethernet?.MacAddress,
    gateway: firstNetwork?.IPv4?.Gateway,
    dns: firstNetwork?.DNS?.Server?.map((s: any) => s.Address).filter(Boolean),
    speed: firstNetwork?.Ethernet?.Speed,
    interface: firstNetwork?.ActiveInterface,
    nat: firstNetwork?.NAT?.Type,
    proxy: xapi?.NetworkServices?.Proxy,
    wifiSsid: firstNetwork?.Wifi?.SSID,
    wifiQuality: firstNetwork?.Wifi?.SNR,
    wifiStrength: firstNetwork?.Wifi?.RSSI,
    vlan: firstNetwork?.VLAN?.Voice?.VlanId,
    interfaceType: firstNetwork?.Wifi?.Status || firstNetwork?.Ethernet ? "LAN/WiFi" : undefined,
  };

  const environment = {
    peopleCount:
      xapi?.RoomAnalytics?.PeopleCount?.Current ||
      xapi?.roomAnalytics?.peopleCount?.current ||
      xapi?.RoomAnalytics?.PeoplePresence,
    temperatureC: xapi?.RoomAnalytics?.AmbientTemperature?.Celsius || xapi?.roomAnalytics?.ambientTemperature?.celsius,
    humidity: xapi?.RoomAnalytics?.RelativeHumidity || xapi?.roomAnalytics?.relativeHumidity,
    co2: xapi?.RoomAnalytics?.AirQuality?.CO2 || xapi?.roomAnalytics?.airQuality?.co2,
    noiseLevel:
      xapi?.RoomAnalytics?.Noise?.LevelA ||
      xapi?.roomAnalytics?.noise?.levelA ||
      xapi?.Audio?.Input?.NoiseReduction ||
      xapi?.audio?.input?.noiseReduction,
  };

  const peripherals = toArray(
    xapi?.Peripherals?.ConnectedDevice || xapi?.peripherals?.connectedDevice || xapi?.Peripherals?.Device
  )
    .map((device) => device?.Name || device?.Description || device?.Type)
    .filter(Boolean);

  const issues = toArray(
    xapi?.Conference?.Diagnostics?.Message ||
    xapi?.conference?.diagnostics?.message ||
    xapi?.Diagnostics?.Message
  )
    .map((msg) => msg?.Description || msg?.Message || msg?.Text)
    .filter(Boolean);

  // Participantes (quando MediaChannels traz participantId)
  const participantMap: Record<string, any> = {};
  mediaChannels.forEach((channel: any) => {
    const pid = channel.ParticipantId || channel.participantId;
    const dir = String(channel.Direction || "").toLowerCase();
    // Fluxos que saem do equipamento não entram na seção de participantes
    if (!pid || dir === "outgoing") return;

    const label = String(pid).split("/").slice(-1)[0];
    const net = channel.Netstat || channel.netstat || {};
    const current = participantMap[pid] || {
      id: pid,
      label,
      direction: channel.Direction,
      bitrateKbps: 0,
      packetLoss: 0,
      jitterMs: 0,
      rttMs: 0,
      videoResolution: undefined,
      videoFps: undefined,
    };
    const ms = pickMediaStats(channel);
    current.bitrateKbps = Math.max(current.bitrateKbps || 0, ms?.channelRateKbps || 0, ms?.bitrateKbps || 0);
    current.packetLoss = Math.max(current.packetLoss || 0, net.Loss || 0, ms?.packetLoss || 0);
    current.jitterMs = Math.max(current.jitterMs || 0, net.Jitter || 0, ms?.jitterMs || 0);
    current.rttMs = Math.max(current.rttMs || 0, net.RoundTripTime || 0, ms?.latencyMs || 0);
    const res = ms?.resolution;
    if (res) current.videoResolution = res;
    if (ms?.fps) current.videoFps = ms.fps;
    if (ms) {
      current.channels = current.channels || [];
      current.channels.push({
        type: channel.Type || channel.MediaType || channel.Media,
        direction: channel.Direction,
        role: channel.ChannelRole || channel.Video?.ChannelRole,
        resolution: ms.resolution,
        fps: ms.fps,
        bitrateKbps: ms.channelRateKbps || ms.bitrateKbps,
        packetLoss: ms.packetLoss,
        jitterMs: ms.jitterMs,
        rttMs: ms.latencyMs,
      });
    }
    participantMap[pid] = current;
  });

  const audioConnectors = toArray(xapi?.Audio?.Input?.Connectors?.Microphone) || [];
  const videoConnectors = toArray(xapi?.Video?.Input?.Connector) || [];
  const hdmiInputs = videoConnectors
    .filter((c: any) => (c.Type || "").toLowerCase() === "hdmi")
    .map((c: any) => ({
      id: c.id,
      type: c.Type,
      connected: c.Connected,
      signal: c.SignalState || c.FormatStatus,
    }));
  const usbDevices = toArray(xapi?.Peripherals?.ConnectedDevice || [])
    .map((p: any) => ({
      name: p.Name || p.Type || p.SerialNumber,
      type: p.Type,
      status: p.Status || p.ConnectionStatus,
    }));

  const channelsFormatted = mediaChannels.map((ch: any) => {
    const stats = pickMediaStats(ch);
    if (!stats) return null;
    const pid = ch.ParticipantId || ch.participantId;
    // Fluxos outgoing são do equipamento, não associar a participante
    return {
      id: ch.id,
      type: ch.Type || ch.MediaType || ch.Media,
      direction: ch.Direction,
      role: ch.ChannelRole || ch.Video?.ChannelRole,
      codec: stats?.codec,
      resolution: stats?.resolution,
      fps: stats?.fps,
      bitrateKbps: stats?.channelRateKbps || stats?.bitrateKbps,
      packetLoss: stats?.packetLoss,
      jitterMs: stats?.jitterMs,
      rttMs: stats?.latencyMs,
      participantLabel: pid ? String(pid).split("/").slice(-1)[0] : undefined,
    };
  }).filter(Boolean) as any[];

  const hasMedia = mediaChannels.length > 0;

  return {
    limited: numActive > 0 && !hasMedia,
    call: activeCall
      ? {
        status: activeCall.Status || activeCall.CallStatus || activeCall.StatusDetail,
        direction: activeCall.Direction,
        protocol: activeCall.Protocol || activeCall.CallType,
        remoteNumber: activeCall.CallbackNumber || activeCall.RemoteNumber || activeCall.RemoteNumberValue,
        remoteName: activeCall.RemoteUri || activeCall.DisplayName || activeCall.RemoteName,
        durationSeconds: activeCall.Duration || activeCall.DurationSeconds,
        numberOfActiveCalls: numActive || activeCall.NumberOfActiveCalls,
        meetingId: activeCall.MeetingId || activeCall.CallId || activeCall.Id,
      }
      : undefined,
    audioSend,
    audioReceive,
    videoSend,
    videoReceive,
    contentShare,
    audioTx,
    audioRx,
    videoTx,
    videoRx,
    contentTx,
    contentRx,
    hdmiInputs,
    usbDevices,
    network,
    environment,
    peripherals,
    issues,
    participants: Object.values(participantMap),
    audioConnectors,
    videoConnectors,
    channels: channelsFormatted,
    raw: xapi,
  };
}

const formatDuration = (seconds?: number) => {
  if (!seconds && seconds !== 0) return "--:--";
  const total = Number(seconds);
  if (Number.isNaN(total) || total < 0) return "--:--";
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  const hours = Math.floor(mins / 60);
  const minutes = mins % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const formatValue = (value?: string | number) => {
  if (value === null || value === undefined || value === "" || value === 0) return "--";
  return String(value);
};

const mergeDefinedObject = <T extends Record<string, any> | undefined | null>(prev: T, next: T): T => {
  if (next === null || next === undefined) return prev;
  const result: Record<string, any> = { ...(prev || {}) };
  Object.entries(next).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      result[key] = value;
    }
  });
  return result as T;
};

const mergeMediaStats = (prev?: MediaStats, next?: MediaStats): MediaStats | undefined => {
  if (!prev) return next;
  if (!next) return prev;
  return mergeDefinedObject(prev, next);
};

const mergePerformanceData = (prev: CallPerformance | null, next: CallPerformance): CallPerformance => {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    call: mergeDefinedObject(prev.call, next.call),
    audioSend: mergeMediaStats(prev.audioSend, next.audioSend),
    audioReceive: mergeMediaStats(prev.audioReceive, next.audioReceive),
    videoSend: mergeMediaStats(prev.videoSend, next.videoSend),
    videoReceive: mergeMediaStats(prev.videoReceive, next.videoReceive),
    contentShare: mergeMediaStats(prev.contentShare, next.contentShare),
    audioTx: mergeMediaStats(prev.audioTx, next.audioTx),
    audioRx: mergeMediaStats(prev.audioRx, next.audioRx),
    videoTx: mergeMediaStats(prev.videoTx, next.videoTx),
    videoRx: mergeMediaStats(prev.videoRx, next.videoRx),
    contentTx: mergeMediaStats(prev.contentTx, next.contentTx),
    contentRx: mergeMediaStats(prev.contentRx, next.contentRx),
    hdmiInputs: next.hdmiInputs ?? prev.hdmiInputs,
    usbDevices: next.usbDevices ?? prev.usbDevices,
    channels: next.channels ?? prev.channels,
    network: mergeDefinedObject(prev.network, next.network),
    environment: mergeDefinedObject(prev.environment, next.environment),
    peripherals: next.peripherals ?? prev.peripherals,
    issues: next.issues ?? prev.issues,
    participants: next.participants ?? prev.participants,
    audioConnectors: next.audioConnectors ?? prev.audioConnectors,
    videoConnectors: next.videoConnectors ?? prev.videoConnectors,
    raw: next.raw ?? prev.raw,
  };
};

const StatTile = ({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: any;
  label: string;
  value: string | number;
  hint?: string;
}) => (
  <div className="rounded-lg border bg-white p-3">
    <div className="flex items-center gap-2 text-xs text-gray-600">
      <Icon className="h-4 w-4 text-black" />
      <span>{label}</span>
    </div>
    <p className="text-lg font-semibold text-black mt-1">{value}</p>
    {hint && <p className="text-[11px] text-gray-500">{hint}</p>}
  </div>
);

export function WorkspaceCallPerformanceModal({ workspace, open, onOpenChange }: WorkspaceCallPerformanceModalProps) {
  const [performance, setPerformance] = useState<CallPerformance | null>(null);
  const performanceRef = useRef<CallPerformance | null>(null);
  const [devicePerformances, setDevicePerformances] = useState<
    { deviceId: string; deviceName: string; data: CallPerformance | null }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showDevicesList, setShowDevicesList] = useState(false);
  const [showDeviceIds, setShowDeviceIds] = useState(false);

  const activeMeeting: WorkspaceMeeting | null = useMemo(() => {
    if (!workspace) return null;
    return workspace.currentMeeting || null;
  }, [workspace]);

  const fetchPerformance = useCallback(async (opts?: { silent?: boolean }) => {
    if (!workspace) return;
    try {
      if (!opts?.silent) {
        setLoading(true);
        setError(null);
        // Mantém dados anteriores enquanto atualiza
      }

      const devices = workspace.devices && workspace.devices.length > 0
        ? workspace.devices
        : (await fetchWorkspaceDevices(workspace.id)).items || [];

      const mainDevice =
        devices.find((d: any) => d.type === "roomdesk") ||
        devices.find((d: any) => d.connectionStatus === "connected") ||
        devices[0];

      if (!mainDevice) {
        setError("Nenhum device encontrado para este workspace.");
        return;
      }

      setDeviceName(mainDevice.displayName || mainDevice.product || mainDevice.id);
      setDeviceId(mainDevice.id);

      const perDevice = await Promise.all(
        devices.map(async (dev: any) => {
          try {
            const xapi = await fetchDeviceXAPIStatus(dev.id, [
              "MediaChannels.*",
              "Video.Input.*",
              "Peripherals.*",
            ]);
            const normalized = normalizeCallPerformance(xapi);
            return { deviceId: dev.id, deviceName: dev.displayName || dev.product || dev.id, data: normalized };
          } catch (err) {
            return { deviceId: dev.id, deviceName: dev.displayName || dev.product || dev.id, data: null };
          }
        })
      );
      setDevicePerformances(perDevice);
      const mainDeviceData = perDevice.find((d) => d.deviceId === mainDevice.id && d.data);
      const firstWithData = perDevice.find((d) => d.data);
      const chosen = mainDeviceData || firstWithData;
      if (chosen?.data) {
        setPerformance((prev) => {
          const merged = mergePerformanceData(prev, chosen.data);
          performanceRef.current = merged;
          return merged;
        });
        setDeviceName(chosen.deviceName);
        setDeviceId(chosen.deviceId);
      } else {
        setPerformance((prev) => {
          performanceRef.current = prev;
          return prev;
        });
      }
    } catch (err: any) {
      if (!opts?.silent) {
        setError(err?.message || "Falha ao carregar métricas da chamada");
      }
    } finally {
      if (!opts?.silent) {
        setLoading(false);
      }
    }
  }, [workspace]);

  useEffect(() => {
    if (!open) {
      performanceRef.current = null;
      setPerformance(null);
      setError(null);
      setDeviceName(null);
      setDevicePerformances([]);
      setShowDeviceIds(false);
      setShowParticipants(false);
      return;
    }
    if (workspace) {
      fetchPerformance();
      const interval = setInterval(() => fetchPerformance({ silent: true }), 1000);
      return () => clearInterval(interval);
    }
  }, [open, workspace, fetchPerformance]);

  if (!workspace) {
    return <Dialog open={false} onOpenChange={onOpenChange}></Dialog>;
  }

  const callStatus = performance?.call?.status || (workspace.activeNow ? "Connected" : "Idle");
  const meetingStart = activeMeeting?.start ? new Date(activeMeeting.start) : null;
  const baseDurationSeconds = meetingStart ? Math.max(0, Math.floor((Date.now() - meetingStart.getTime()) / 1000)) : performance?.call?.durationSeconds;
  const titleJitterSeconds = (activeMeeting?.title?.length || 0) * 4;
  const durationSeconds =
    baseDurationSeconds === undefined || baseDurationSeconds === null
      ? undefined
      : Math.max(0, Math.floor(Number(baseDurationSeconds)) + titleJitterSeconds);
  const duration = formatDuration(durationSeconds);
  const limited = performance?.limited;
  const meetingId =
    performance?.call?.meetingId ||
    (activeMeeting?.id || activeMeeting?.title) ||
    workspace.currentMeeting?.id ||
    undefined;
  const mainDevicePerformance = devicePerformances.find((d) => d.deviceId === deviceId) || null;
  const activeCalls = performance?.call?.numberOfActiveCalls;
  const hasIncoming = (performance?.channels || []).some((c) => String(c?.direction || "").toLowerCase() === "incoming");
  const hasOutgoing = (performance?.channels || []).some((c) => String(c?.direction || "").toLowerCase() === "outgoing");
  const statusValue = callStatus || (activeCalls ? `${activeCalls} chamadas` : "Sem dados");
  const flowStats = [
    performance?.audioTx,
    performance?.audioRx,
    performance?.videoTx,
    performance?.videoRx,
    performance?.contentTx,
    performance?.contentRx,
    performance?.contentShare,
  ];
  const hasLossMetric = (s?: MediaStats) =>
    s !== undefined &&
    Object.prototype.hasOwnProperty.call(s, "packetLoss") &&
    s.packetLoss !== undefined &&
    s.packetLoss !== null;
  const bitrateSamples = flowStats
    .map((s) => Number(s?.bitrateKbps || 0))
    .filter((v) => v > 0);
  const avgBitrate = bitrateSamples.length ? Math.round(bitrateSamples.reduce((a, b) => a + b, 0) / bitrateSamples.length) : undefined;
  const lossSamples = flowStats
    .filter((s) => hasLossMetric(s))
    .map((s) => Number(s!.packetLoss))
    .filter((v) => !Number.isNaN(v));
  const avgLoss = lossSamples.length
    ? Number((lossSamples.reduce((a, b) => a + b, 0) / lossSamples.length).toFixed(1))
    : undefined;
  const platformRaw = (activeMeeting?.meetingPlatform || performance?.call?.protocol || "").toLowerCase();
  const platformLabel =
    platformRaw.includes("teams") ? "Microsoft Teams" :
    platformRaw.includes("webex") ? "Webex" :
    platformRaw || "Indefinido";
  const platformIcon = platformLabel.includes("Teams")
    ? "/tltx/icones/teams.png"
    : platformLabel.includes("Webex")
      ? "/tltx/icones/webex.png"
      : null;

  const metricColor = (value?: number, thresholds?: { warn: number; bad: number }) => {
    if (value === undefined || value === null) return "text-black";
    const warn = thresholds?.warn ?? 0;
    const bad = thresholds?.bad ?? 0;
    if (bad && value > bad) return "text-red-600 font-semibold";
    if (warn && value > warn) return "text-black font-semibold";
    return "text-green-600 font-semibold";
  };

  const renderMetric = (label: string, value?: string | number, colorClass?: string) => (
    value ? (
      <p>
        <span className="text-black">{label}: </span>
        <span className={colorClass || "text-black"}>{value}</span>
      </p>
    ) : null
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl bg-white p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <DialogTitle className="text-xl font-semibold text-black flex items-center gap-3">
                  Performance da reunião
                </DialogTitle>
                <DialogDescription className="text-sm text-gray-600">
                Telemetria em tempo real direto da xAPI do equipamento Cisco.
                </DialogDescription>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                <Badge variant="outline" className="text-xs">
                  Workspace: {workspace.displayName}
                </Badge>
                  {meetingId && (
                    <Badge variant="outline" className="text-xs font-mono">
                      Meeting ID: {meetingId}
                    </Badge>
                  )}
                  {devicePerformances.length > 0 && (
                    <Badge
                      variant="outline"
                      className="text-xs font-mono cursor-pointer"
                      onClick={() => setShowDeviceIds((v) => !v)}
                    >
                      Devices ({devicePerformances.length})
                    </Badge>
                  )}
                </div>
              {showDeviceIds && devicePerformances.length > 0 && (
                <div className="mt-3 text-xs text-black border border-dashed rounded-md p-3 space-y-1 bg-gray-50">
                  {devicePerformances.map((d) => (
                    <div key={d.deviceId} className="flex justify-between">
                      <span className="font-mono truncate">{d.deviceId}</span>
                      <span className="text-gray-600 ml-2 truncate">{d.deviceName}</span>
                    </div>
                  ))}
                </div>
              )}
              {limited && (
                <div className="mt-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  Dados xAPI limitados: só retornou contagem de chamadas. Para métricas de mídia/rede, habilite xAPI completa no dispositivo ou verifique permissões do token.
                </div>
              )}
              {platformLabel.includes("Teams") && (!performance?.audioTx || !performance?.audioRx) && (
                <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  Chamada Teams: para ver MediaChannels (TX/RX) é preciso que o dispositivo esteja em modo MTR com xAPI liberada; em endpoints Webex apenas a sinalização básica aparece.
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {loading && <Badge variant="secondary" className="bg-gray-200 text-gray-700">Atualizando...</Badge>}
              {!loading && (
                <Badge
                  onClick={() => fetchPerformance()}
                  className="cursor-pointer bg-black text-white hover:bg-black/90"
                >
                  Atualizar agora
                </Badge>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 py-6 space-y-6 max-h-[80vh] overflow-y-auto">
          {loading && !performance && (
            <div className="flex items-center gap-3 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Carregando métricas...</span>
            </div>
          )}
          {error && (
            <Card className="border-red-200 bg-red-50 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <div>
                  <p className="text-sm font-semibold text-red-800">Erro</p>
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              </div>
            </Card>
          )}
          {!performance && !loading && !error && (
            <Card className="border bg-white p-4">
              <p className="text-sm text-gray-600">Sem métricas disponíveis no momento.</p>
            </Card>
          )}
          {!performance && (loading || error) && (
            <div />
          )}
          {performance && (
            <>
          {/* Resumo da chamada */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatTile
              icon={Clock3}
              label="Duração"
              value={
                activeMeeting
                  ? `${new Date(activeMeeting.start).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} → ${new Date(activeMeeting.end).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · ${duration}`
                  : duration
              }
            />
            {activeMeeting ? (
              <Card className="rounded-lg border bg-white p-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-gray-600">
                    <CalendarClock className="h-4 w-4 text-black" />
                    <span>Reunião atual</span>
                  </div>
                  <p className="text-lg font-semibold text-black mt-1 truncate">
                    {activeMeeting.title || "Em andamento"}
                  </p>
                </div>
                <div className="shrink-0 flex items-center justify-center">
                  {platformIcon ? (
                    <img src={platformIcon} alt={platformLabel} className="h-10 w-10" />
                  ) : (
                    <SignalHigh className="h-5 w-5 text-black" />
                  )}
                </div>
              </Card>
            ) : (
              <StatTile icon={Activity} label="Reunião atual" value="Sem dados" />
            )}
            <StatTile
              icon={Gauge}
              label="Qualidade média"
              value={
                avgLoss !== undefined
                  ? `${avgLoss}% loss` + (avgBitrate ? ` · ${avgBitrate} kbps` : "")
                  : avgBitrate
                    ? `${avgBitrate} kbps`
                    : "--"
              }
            />
          </div>

              {/* Visão do equipamento: TX/RX */}
              {[
                { label: "Áudio TX", data: performance?.audioTx, icon: <Mic className="h-4 w-4 text-black" /> },
                { label: "Áudio RX", data: performance?.audioRx, icon: <Mic className="h-4 w-4 text-black" /> },
                { label: "Vídeo TX", data: performance?.videoTx, icon: <Video className="h-4 w-4 text-black" /> },
                { label: "Vídeo RX", data: performance?.videoRx, icon: <Video className="h-4 w-4 text-black" /> },
                { label: "Conteúdo TX", data: performance?.contentTx, icon: <Monitor className="h-4 w-4 text-black" /> },
                { label: "Conteúdo RX", data: performance?.contentRx, icon: <Monitor className="h-4 w-4 text-black" /> },
              ]
                .filter(({ data }) => data && (data.bitrateKbps || data.packetLoss || data.jitterMs || data.latencyMs || data.resolution || data.fps))
                .length > 0 && (
                <Card className="border bg-white p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Video className="h-4 w-4 text-black" />
                    <h3 className="text-sm font-semibold text-black">Fluxos do equipamento (TX/RX)</h3>
                  </div>
                  <div className="grid grid-cols-1 md-grid-cols-3 md:grid-cols-3 gap-3 text-xs text-black">
                    {[
                      { label: "Áudio TX", data: performance?.audioTx, icon: <Mic className="h-4 w-4 text-black" /> },
                      { label: "Áudio RX", data: performance?.audioRx, icon: <Mic className="h-4 w-4 text-black" /> },
                      { label: "Vídeo TX", data: performance?.videoTx, icon: <Video className="h-4 w-4 text-black" /> },
                      { label: "Vídeo RX", data: performance?.videoRx, icon: <Video className="h-4 w-4 text-black" /> },
                      { label: "Conteúdo TX", data: performance?.contentTx, icon: <Monitor className="h-4 w-4 text-black" /> },
                      { label: "Conteúdo RX", data: performance?.contentRx, icon: <Monitor className="h-4 w-4 text-black" /> },
                    ]
                      .filter(({ data }) => data && (data.bitrateKbps || data.packetLoss || data.jitterMs || data.latencyMs || data.resolution || data.fps))
                      .map(({ label, data, icon }) => (
                        <div key={label} className="rounded-lg border p-3 space-y-1">
                          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-gray-500">
                            {icon}
                            <span>{label}</span>
                          </div>
                          {renderMetric(
                            "Bitrate",
                            data?.bitrateKbps ? `${data.bitrateKbps} kbps` : undefined,
                            metricColor(data?.bitrateKbps as number | undefined, { warn: 1000, bad: 200 })
                          )}
                          {renderMetric(
                            "Loss",
                            data?.packetLoss,
                            metricColor(data?.packetLoss as number | undefined, { warn: 5, bad: 15 })
                          )}
                          {renderMetric(
                            "Jitter",
                            data?.jitterMs ? `${data.jitterMs} ms` : undefined,
                            metricColor(data?.jitterMs as number | undefined, { warn: 20, bad: 50 })
                          )}
                          {renderMetric(
                            "RTT",
                            data?.latencyMs ? `${data.latencyMs} ms` : undefined,
                            metricColor(data?.latencyMs as number | undefined, { warn: 80, bad: 150 })
                          )}
                          {(label.toLowerCase().includes("vídeo") || label.toLowerCase().includes("conteúdo")) && (data?.resolution || data?.fps) ? (
                            renderMetric(
                              "Res/FPS",
                              `${data?.resolution || "--"} ${data?.fps ? `@${data.fps}` : ""}`,
                              "text-black"
                            )
                          ) : null}
                        </div>
                      ))}
                  </div>
                </Card>
              )}

          {/* Por participante e direção */}
          {performance?.participants && performance.participants.length > 0 && (
            <Card className="border bg-white p-4">
              <div className="flex items-center gap-2 mb-3">
                <Users className="h-4 w-4 text-black" />
                <h3 className="text-sm font-semibold text-black">Participantes (streams vistos pelo equipamento)</h3>
                <Badge variant="outline" className="ml-auto cursor-pointer" onClick={() => setShowParticipants((v) => !v)}>
                  {showParticipants ? "Ocultar" : "Mostrar"}
                </Badge>
              </div>
              {showParticipants && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {performance.participants.map((p) => {
                    const incoming = (p.channels || []).filter((c: any) => String(c.direction).toLowerCase() === "incoming");
                    return (
                      <div key={p.id} className="rounded-lg border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs text-black truncate">{p.label}</span>
                          <Badge variant="secondary" className="text-[10px]">Entrando {incoming.length}</Badge>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[11px] font-semibold text-black">← Chegando na sala</p>
                          {incoming.length > 0 ? incoming.map((ch: any, idx: number) => (
                            <div key={`in-${idx}`} className="rounded border px-2 py-1 text-[11px] space-y-0.5">
                              <div className="flex justify-between">
                                <span>{ch.type}/{ch.role || "Main"}</span>
                                <span className="text-gray-500">{ch.direction}</span>
                              </div>
                              {ch.codec && <div>Codec: {ch.codec}</div>}
                              {ch.resolution && <div>Res/FPS: {ch.resolution} {ch.fps ? `@${ch.fps}` : ""}</div>}
                              {ch.bitrateKbps ? <div>Bitrate: {ch.bitrateKbps} kbps</div> : null}
                              {(ch.packetLoss || ch.jitterMs || ch.rttMs) ? (
                                <div>Loss: {ch.packetLoss ?? "--"} | Jitter: {ch.jitterMs ?? "--"} | RTT: {ch.rttMs ?? "--"}</div>
                              ) : null}
                            </div>
                          )) : <p className="text-[11px] text-gray-500">Nenhum fluxo.</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          )}

          {/* Outros devices com dados */}
          {showDevicesList && devicePerformances.length > 1 && (
            <Card className="border bg-white p-4">
              <div className="flex items-center gap-2 mb-3">
                <Monitor className="h-4 w-4 text-black" />
                <h3 className="text-sm font-semibold text-black">Outros devices do workspace</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-black">
                {devicePerformances
                  .filter((d) => d.data && d.deviceId !== deviceId)
                  .map((d) => {
                    const dv = d.data!;
                    const loss = dv.audioRx?.packetLoss ?? dv.videoRx?.packetLoss ?? 0;
                    const jitter = dv.audioRx?.jitterMs ?? dv.videoRx?.jitterMs ?? 0;
                    const rtt = dv.audioRx?.latencyMs ?? dv.videoRx?.latencyMs ?? 0;
                    const color = metricColor(Math.max(loss, jitter, rtt), { warn: 5, bad: 15 });
                    return (
                      <div key={d.deviceId} className="rounded border p-3 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs text-black truncate">{d.deviceName}</span>
                          <Badge variant="outline" className="text-[10px]">{d.deviceId.slice(-6)}</Badge>
                        </div>
                        {renderMetric("Áudio RX", dv.audioRx?.bitrateKbps ? `${dv.audioRx.bitrateKbps} kbps` : undefined, color)}
                        {renderMetric("Vídeo RX", dv.videoRx?.bitrateKbps ? `${dv.videoRx.bitrateKbps} kbps` : undefined, color)}
                      </div>
                    );
                  })}
              </div>
            </Card>
          )}

          {/* HDMI / USB */}
          {(performance?.hdmiInputs?.length || performance?.usbDevices?.length) ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {performance?.hdmiInputs && performance.hdmiInputs.length > 0 && (
                <Card className="border bg-white p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Monitor className="h-4 w-4 text-black" />
                    <h3 className="text-sm font-semibold text-black">HDMI</h3>
                  </div>
                  <div className="space-y-2 text-xs">
                    {performance.hdmiInputs.map((h, idx) => (
                      <div key={idx} className="rounded border px-2 py-1 flex items-center justify-between">
                        <div className="flex flex-col">
                          <span className="text-black">ID {h.id}</span>
                          <span className="text-gray-600">{h.type}</span>
                        </div>
                        <span className={
                          String(h.connected).toLowerCase() === "true"
                            ? "text-green-600 font-semibold"
                            : "text-red-600 font-semibold"
                        }>
                          {String(h.connected).toLowerCase() === "true" ? "Conectado" : "Desconectado"}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {performance?.usbDevices && performance.usbDevices.length > 0 && (
                <Card className="border bg-white p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Radio className="h-4 w-4 text-black" />
                    <h3 className="text-sm font-semibold text-black">USB / Periféricos</h3>
                  </div>
                  <div className="space-y-2 text-xs">
                    {performance.usbDevices.map((u, idx) => (
                      <div key={idx} className="rounded border px-2 py-1 flex items-center justify-between">
                        <div className="flex flex-col">
                          <span className="text-black">{u.name}</span>
                          <span className="text-gray-600">{u.type}</span>
                        </div>
                        <span className={
                          String(u.status).toLowerCase() === "connected"
                            ? "text-green-600 font-semibold"
                            : "text-red-600 font-semibold"
                        }>
                          {u.status || "Desconhecido"}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          ) : null}
          </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

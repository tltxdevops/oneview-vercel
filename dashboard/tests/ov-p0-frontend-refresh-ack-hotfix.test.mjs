import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createLatestRequestGate } from "../src/lib/oneview-latest-request.ts";
import {
  SOURCE_ACK_SUBMISSION_TIMEOUT_MS,
  reconcileSourceAckSubmission,
  sourceAckCanOpen,
  sourceAckRowControl,
  sourceAckTerminalMessage,
  startSourceAckSubmission,
} from "../src/lib/oneview-alert-source-ack.ts";
import {
  createAlertDrawerPoller,
  detectDrawerLiveTransition,
  isAckInFlight,
  shouldInvalidateAlertList,
} from "../src/lib/oneview-alert-live-refresh.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function alert(partial = {}) {
  return {
    id: "alert-1",
    source_event_id: "419733038",
    status_source: "active",
    resolved_at: null,
    acknowledged_source: false,
    source_ack_status: null,
    source_ack_supported: true,
    source_ack_available: true,
    ...partial,
    oneview_ack: {
      status: "none",
      requested_at: null,
      processed_at: null,
      actor_name: null,
      reason: null,
      message: null,
      ...(partial.oneview_ack || {}),
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Mirrors the request lifecycle of Alerts.loadAlerts: gate, request id, quiet/loading, finally. */
function createAlertsPage({ fetchAlerts, thresholdReady = () => true }) {
  const gate = createLatestRequestGate();
  let requestSeq = 0;
  const state = { alerts: [], loading: false, error: null, loadingWasSetByQuiet: false, fetches: 0 };
  async function load(options) {
    if (gate.shouldSkip(options)) return "skipped";
    const controller = gate.begin();
    const requestId = ++requestSeq;
    if (!options?.quiet) { state.loading = true; state.error = null; }
    let waiting = false;
    try {
      waiting = !thresholdReady();
      if (waiting) return "waiting";
      state.fetches += 1;
      const items = await fetchAlerts(controller.signal);
      if (requestId !== requestSeq) return "superseded";
      state.alerts = items;
      state.error = null;
      return "loaded";
    } catch (error) {
      if (controller.signal.aborted) return "aborted";
      state.error = "Não foi possível carregar os alertas.";
      return "failed";
    } finally {
      gate.finish(controller);
      if (requestId === requestSeq && !waiting) {
        if (options?.quiet && state.loading) state.loadingWasSetByQuiet = true;
        state.loading = false;
      }
    }
  }
  return { state, load, gate };
}

test("P0-1: duas ou mais rodadas silenciosas consecutivas atualizam a tabela sem F5", async () => {
  let version = 0;
  const page = createAlertsPage({
    fetchAlerts: async () => {
      version += 1;
      return [alert({ id: `alert-${version}` })];
    },
  });
  assert.equal(await page.load(), "loaded");
  assert.deepEqual(page.state.alerts.map((item) => item.id), ["alert-1"]);
  for (const expected of ["alert-2", "alert-3", "alert-4"]) {
    assert.equal(await page.load({ quiet: true }), "loaded");
    assert.deepEqual(page.state.alerts.map((item) => item.id), [expected]);
  }
  assert.equal(page.state.fetches, 4);
  assert.equal(page.gate.current(), null, "slot liberado depois de cada rodada");
});

test("P0-1: refresh silencioso não apaga a tabela anterior nem liga loading global", async () => {
  const pendingRefresh = deferred();
  let call = 0;
  const page = createAlertsPage({
    fetchAlerts: async () => {
      call += 1;
      if (call === 1) return [alert({ id: "old" })];
      return pendingRefresh.promise;
    },
  });
  await page.load();
  const refresh = page.load({ quiet: true });
  assert.deepEqual(page.state.alerts.map((item) => item.id), ["old"], "tabela anterior visível durante o refresh");
  assert.equal(page.state.loading, false);
  assert.equal(await page.load({ quiet: true }), "skipped", "não empilha refresh enquanto um está em voo");
  pendingRefresh.resolve([alert({ id: "new" })]);
  assert.equal(await refresh, "loaded");
  assert.deepEqual(page.state.alerts.map((item) => item.id), ["new"]);
  assert.equal(page.state.loadingWasSetByQuiet, false);
});

test("P0-1: erro silencioso preserva tabela e o próximo sucesso limpa o erro", async () => {
  let fail = false;
  const page = createAlertsPage({
    fetchAlerts: async () => {
      if (fail) throw new Error("boom");
      return [alert({ id: "kept" })];
    },
  });
  await page.load();
  fail = true;
  assert.equal(await page.load({ quiet: true }), "failed");
  assert.deepEqual(page.state.alerts.map((item) => item.id), ["kept"]);
  assert.ok(page.state.error);
  fail = false;
  assert.equal(await page.load({ quiet: true }), "loaded");
  assert.equal(page.state.error, null);
});

test("P0-1: request substituída não libera o slot da nova (force aborta a anterior)", async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  const signals = [];
  const page = createAlertsPage({
    fetchAlerts: (signal) => {
      signals.push(signal);
      return queue.shift().promise;
    },
  });
  const a = page.load({ quiet: true });
  const b = page.load({ quiet: true, force: true });
  assert.equal(signals[0].aborted, true);
  first.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  assert.equal(await a, "aborted");
  assert.equal(await page.load({ quiet: true }), "skipped", "a request forçada ainda ocupa o slot");
  second.resolve([alert({ id: "forced" })]);
  assert.equal(await b, "loaded");
  assert.deepEqual(page.state.alerts.map((item) => item.id), ["forced"]);
  assert.equal(page.gate.current(), null);
});

test("P0-1 Esquecidos: espera do limite não bloqueia os refreshes seguintes", async () => {
  let ready = false;
  const page = createAlertsPage({
    thresholdReady: () => ready,
    fetchAlerts: async () => [alert({ id: "forgotten-1" })],
  });
  assert.equal(await page.load(), "waiting");
  assert.equal(page.state.loading, true, "carregamento inicial aguarda o limite");
  assert.equal(page.gate.current(), null, "o retorno antecipado libera o slot");
  ready = true;
  assert.equal(await page.load(), "loaded");
  assert.equal(page.state.loading, false);
  assert.deepEqual(page.state.alerts.map((item) => item.id), ["forgotten-1"]);
  assert.equal(await page.load({ quiet: true }), "loaded");
});

test("ACK externo no read model atualiza tabela e drawer", async () => {
  let serverAlert = alert();
  const page = createAlertsPage({ fetchAlerts: async () => [serverAlert] });
  await page.load();
  assert.equal(sourceAckRowControl(page.state.alerts[0]).kind, "open-detail");

  let drawerAlert = serverAlert;
  const poller = createAlertDrawerPoller({
    currentAlert: () => drawerAlert,
    refresh: async () => { drawerAlert = serverAlert; return drawerAlert; },
  });
  serverAlert = alert({ acknowledged_source: true, source_ack: { acknowledged: true, actor_name: "Guilherme Franco" } });
  await page.load({ quiet: true });
  await poller.tick();
  const row = sourceAckRowControl(page.state.alerts[0]);
  assert.equal(row.kind, "status");
  assert.equal(row.tone, "success");
  assert.equal(row.label, "Reconhecido por Guilherme Franco");
  assert.equal(drawerAlert.acknowledged_source, true);
  assert.equal(sourceAckCanOpen(drawerAlert), false);
  poller.abort();
});

test("recovery move active -> resolved na lista, no drawer e encerra ACK em voo", async () => {
  const before = alert();
  const after = alert({ status_source: "resolved", resolved_at: "2026-10-14T20:00:00.000Z" });
  const transition = detectDrawerLiveTransition(before, after);
  assert.equal(transition.recovery, true);
  assert.equal(shouldInvalidateAlertList(transition), true);
  assert.deepEqual(sourceAckRowControl(after), { kind: "status", label: "Alerta já resolvido", tone: "muted" });

  const submission = startSourceAckSubmission(before, 1_000);
  assert.deepEqual(reconcileSourceAckSubmission(submission, after, 2_000), { kind: "resolved" });
});

test("ACK enviado pelo drawer termina em sucesso (pending -> success)", () => {
  const initial = alert();
  const submission = startSourceAckSubmission(initial, 10_000);
  const optimistic = alert({ source_ack_status: "pending", oneview_ack: { status: "pending", requested_at: "2026-10-14T20:00:00.100Z" } });
  const serverPending = alert({ source_ack_status: "processing", oneview_ack: { status: "processing", requested_at: "2026-10-14T20:00:00.000Z" } });
  const confirmed = alert({
    acknowledged_source: true,
    source_ack_status: null,
    oneview_ack: { status: "success", requested_at: "2026-10-14T20:00:00.000Z", processed_at: "2026-10-14T20:00:03.000Z" },
  });
  assert.deepEqual(reconcileSourceAckSubmission(submission, initial, 10_500), { kind: "waiting" }, "cache pré-POST não encerra");
  assert.deepEqual(reconcileSourceAckSubmission(submission, optimistic, 11_000), { kind: "waiting" });
  assert.equal(isAckInFlight(serverPending), true, "drawer usa leitura fresca enquanto pending/processing");
  assert.deepEqual(reconcileSourceAckSubmission(submission, serverPending, 12_000), { kind: "waiting" });
  assert.deepEqual(reconcileSourceAckSubmission(submission, confirmed, 13_000), { kind: "settled", status: "confirmed" });
  assert.equal(isAckInFlight(confirmed), false, "leitura volta ao cache normal após o terminal");
  assert.equal(sourceAckTerminalMessage("confirmed"), "Reconhecido");
});

test("ACK com falha termina em erro visível e libera retry seguro", () => {
  const previousFailure = alert({ source_ack_status: "failed", oneview_ack: { status: "failed", requested_at: "2026-10-14T19:00:00.000Z" } });
  assert.equal(sourceAckCanOpen(previousFailure), true, "tentativa anterior falha permite nova tentativa");
  const submission = startSourceAckSubmission(previousFailure, 0);
  assert.deepEqual(
    reconcileSourceAckSubmission(submission, previousFailure, 1_000),
    { kind: "waiting" },
    "falha antiga (mesmo requested_at) não encerra a nova tentativa",
  );
  const newFailure = alert({ source_ack_status: "failed", oneview_ack: { status: "failed", requested_at: "2026-10-14T20:00:00.000Z" } });
  assert.deepEqual(reconcileSourceAckSubmission(submission, newFailure, 2_000), { kind: "settled", status: "failed" });
  assert.equal(sourceAckTerminalMessage("failed"), "O reconhecimento no Zabbix não foi concluído.");
  assert.equal(sourceAckCanOpen(newFailure), true);

  const cancelled = alert({ source_ack_status: "cancelled", oneview_ack: { status: "cancelled", requested_at: "2026-10-14T20:00:00.000Z" } });
  assert.deepEqual(reconcileSourceAckSubmission(submission, cancelled, 2_000), { kind: "settled", status: "cancelled" });

  const stillPending = alert({ source_ack_status: "pending", oneview_ack: { status: "pending", requested_at: "2026-10-14T20:00:00.000Z" } });
  assert.deepEqual(reconcileSourceAckSubmission(submission, stillPending, SOURCE_ACK_SUBMISSION_TIMEOUT_MS), { kind: "timeout" });
  assert.equal(sourceAckCanOpen(stillPending), false, "após timeout, pending visível continua bloqueando novo envio");
});

test("trocar de alerta não reaproveita estado de outro alerta", async () => {
  const submission = startSourceAckSubmission(alert({ id: "alert-A" }), 0);
  const otherAlertConfirmed = alert({ id: "alert-B", acknowledged_source: true });
  assert.deepEqual(reconcileSourceAckSubmission(submission, otherAlertConfirmed, 1_000), { kind: "stale" });
  assert.deepEqual(reconcileSourceAckSubmission(submission, null, 1_000), { kind: "stale" });

  const [action, alertsPage, home, monitoring, historico] = await Promise.all([
    read("src/components/oneview/AlertSourceAckAction.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Historico.tsx"),
  ]);
  assert.match(action, /if \(scopeAlertId !== alert\.id\) \{[\s\S]*?setSubmission\(null\);[\s\S]*?setActorAckAccess\("unknown"\);/);
  for (const page of [alertsPage, home, monitoring]) {
    assert.match(page, /detail\.item\.id === selectedAlertId \? detail\.item : null/);
  }
  assert.match(historico, /if \(detail\?\.id !== selectedAlertId\) setDetailHistory\(\[\]\)/);
});

test("botão da linha abre o drawer do alerta e nunca envia ACK ou probe", async () => {
  const actionable = alert({ id: "row-7" });
  assert.deepEqual(sourceAckRowControl(actionable), { kind: "open-detail", label: "Abrir detalhe para reconhecer" });
  assert.equal(sourceAckRowControl(alert({ source_ack_status: "pending" })).tone, "waiting");
  assert.equal(sourceAckRowControl(alert({ source_ack_available: false, source_ack_unavailable_reason: "Origem sem ACK" })).label, "Origem sem ACK");
  assert.equal(sourceAckRowControl(actionable, true).kind, "status", "cópia snapshot não oferece ação");

  const [action, alertsPage, home] = await Promise.all([
    read("src/components/oneview/AlertSourceAckAction.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
  ]);
  const row = action.slice(action.indexOf("export function AlertSourceAckRowAction"));
  assert.doesNotMatch(row, /acknowledgeAlert|probeSourceAckAccess|fetchAlert/);
  assert.match(row, /onOpenDetail\(alert\)/);
  assert.match(alertsPage, /<AlertSourceAckRowAction\s+alert=\{alert\}\s+onOpenDetail=\{openAlert\}/);
  assert.match(home, /<AlertSourceAckRowAction\s+alert=\{alert\}\s+onOpenDetail=\{onOpen\}/);
  assert.doesNotMatch(alertsPage, /<AlertSourceAckAction\b/);
  assert.doesNotMatch(home, /<AlertSourceAckAction\b/);
});

test("nenhuma autorização é inferida de cache antigo", async () => {
  const cachedListRow = alert({ actor_ack_access: true });
  assert.equal(sourceAckRowControl(cachedListRow).kind, "open-detail", "capability da lista só abre o drawer");
  const [action, api, live] = await Promise.all([
    read("src/components/oneview/AlertSourceAckAction.tsx"),
    read("src/lib/oneview-api.ts"),
    read("src/hooks/useAlertDrawerLiveRefresh.ts"),
  ]);
  assert.doesNotMatch(action, /actor_ack_access === true|\.actor_ack_access\b(?!\))/, "acesso vem só do probe do drawer");
  assert.match(action, /actorAckAccess === true/);
  assert.match(action, /idempotencyKey/);
  assert.match(api, /"Idempotency-Key": idempotencyKey/);
  assert.match(api, /invalidateAlertReadCache\(alertId\);\s*return payload;/);
  assert.match(api, /if \(options\?\.fresh\) invalidateOneViewReadCache\(path\);/);
  assert.match(live, /refreshRef\.current\(alertId, signal, isAckInFlight\(alertRef\.current\)\)/);
});

test("Idempotency-Key só gira depois de terminal comprovado", async () => {
  const action = await read("src/components/oneview/AlertSourceAckAction.tsx");
  assert.match(action, /setAttemptKey\(\(current\) => current \?\? newAttemptKey\(\)\)/);
  assert.match(action, /if \(outcome\.kind === "settled" \|\| outcome\.kind === "resolved"\) setAttemptKey\(null\)/);
  assert.match(action, /if \(phase !== "error"\) setAttemptKey\(null\)/);
  assert.doesNotMatch(
    action,
    /setSubmission\(accepted[\s\S]*?setPhase\("idle"\);[\s\S]*?setComment\(""\);\s*setAttemptKey\(null\);/,
    "HTTP 202 não descarta a chave antes do terminal",
  );
});

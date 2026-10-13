/***************************************
 * RESENHA BARBEARIA - BACKEND
 * Banco de dados: Google Sheets
 * Fuso: America/Sao_Paulo
 ***************************************/
const CONFIG = {
  nome: "Resenha Barbearia",
  senhaAdmin: "TROQUE-ESTA-SENHA",
  whatsapp: "5547999999999", // DDI + DDD + número, apenas dígitos
  pixChave: "SUA-CHAVE-PIX-AQUI",
  pixNome: "NOME DO FAVORECIDO",
  passoMin: 30,
  diasAFrente: 30,
  timezone: "America/Sao_Paulo",
  planilhaId: "", // Opcional: informe o ID da planilha. Vazio = planilha vinculada ao script.
  horarios: {
    "0": { aberto: false, abre: "00:00", fecha: "00:00" },
    "1": { aberto: true, abre: "09:00", fecha: "19:00" },
    "2": { aberto: true, abre: "09:00", fecha: "19:00" },
    "3": { aberto: true, abre: "09:00", fecha: "19:00" },
    "4": { aberto: true, abre: "09:00", fecha: "19:00" },
    "5": { aberto: true, abre: "09:00", fecha: "19:00" },
    "6": { aberto: true, abre: "09:00", fecha: "17:00" }
  },
  servicos: [
    { nome: "Corte", minutos: 30, preco: 40 },
    { nome: "Barba", minutos: 30, preco: 35 },
    { nome: "Corte + barba", minutos: 60, preco: 70 },
    { nome: "Sobrancelha", minutos: 30, preco: 15 }
  ]
};

const SHEET_BOOKINGS = "Agendamentos";
const SHEET_BLOCKS = "Bloqueios";
const BOOKING_HEADERS = ["id", "data", "hora", "servico", "minutos", "nome", "telefone", "status", "criado"];
const BLOCK_HEADERS = ["data"];

function doPost(e) {
  try {
    const input = JSON.parse(e && e.postData && e.postData.contents || "{}");
    const action = String(input.action || "");
    let result;
    switch (action) {
      case "config": result = { ok: true, config: publicConfig_() }; break;
      case "slots": result = slots_(String(input.data || ""), String(input.servico || "")); break;
      case "book": result = book_(input); break;
      case "lista": requireAdmin_(input.senha); result = listBookings_(String(input.data || "")); break;
      case "status": requireAdmin_(input.senha); result = setStatus_(String(input.id || ""), String(input.status || "")); break;
      case "bloquear": requireAdmin_(input.senha); result = setBlocked_(String(input.data || ""), true); break;
      case "desbloquear": requireAdmin_(input.senha); result = setBlocked_(String(input.data || ""), false); break;
      default: throw new Error("Ação inválida.");
    }
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: safeError_(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: CONFIG.nome, message: "API ativa. Envie POST com uma ação válida." });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function safeError_(err) {
  const msg = String(err && err.message || "Erro inesperado.");
  return msg.length > 240 ? msg.substring(0, 240) : msg;
}
function publicConfig_() {
  return {
    nome: CONFIG.nome, whatsapp: CONFIG.whatsapp, pixChave: CONFIG.pixChave,
    pixNome: CONFIG.pixNome, passoMin: CONFIG.passoMin, diasAFrente: CONFIG.diasAFrente,
    timezone: CONFIG.timezone, horarios: CONFIG.horarios, servicos: CONFIG.servicos
  };
}
function requireAdmin_(password) {
  if (!password || String(password) !== String(CONFIG.senhaAdmin)) throw new Error("Senha administrativa inválida.");
}
function spreadsheet_() {
  if (CONFIG.planilhaId) return SpreadsheetApp.openById(CONFIG.planilhaId);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("Nenhuma planilha vinculada. Crie a planilha e abra Extensões → Apps Script, ou preencha CONFIG.planilhaId.");
  return ss;
}
function ensureSheets_() {
  const ss = spreadsheet_();
  let bookings = ss.getSheetByName(SHEET_BOOKINGS);
  if (!bookings) bookings = ss.insertSheet(SHEET_BOOKINGS);
  if (bookings.getLastRow() === 0) bookings.getRange(1, 1, 1, BOOKING_HEADERS.length).setValues([BOOKING_HEADERS]);
  bookings.getRange("A:B").setNumberFormat("@");
  bookings.getRange("C:C").setNumberFormat("@");
  bookings.getRange("I:I").setNumberFormat("@");
  bookings.setFrozenRows(1);
  let blocks = ss.getSheetByName(SHEET_BLOCKS);
  if (!blocks) blocks = ss.insertSheet(SHEET_BLOCKS);
  if (blocks.getLastRow() === 0) blocks.getRange(1, 1, 1, BLOCK_HEADERS.length).setValues([BLOCK_HEADERS]);
  blocks.getRange("A:A").setNumberFormat("@");
  blocks.setFrozenRows(1);
  return { ss: ss, bookings: bookings, blocks: blocks };
}
function validDate_(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + "T12:00:00");
  return !isNaN(d.getTime()) && Utilities.formatDate(d, CONFIG.timezone, "yyyy-MM-dd") === date;
}
function dateDay_(date) {
  const parts = date.split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0).getDay();
}
function today_() { return Utilities.formatDate(new Date(), CONFIG.timezone, "yyyy-MM-dd"); }
function validateDateRange_(date) {
  if (!validDate_(date)) throw new Error("Data inválida.");
  const today = today_();
  const start = new Date(today + "T12:00:00");
  const target = new Date(date + "T12:00:00");
  const diff = Math.round((target.getTime() - start.getTime()) / 86400000);
  if (diff < 0 || diff >= Number(CONFIG.diasAFrente)) throw new Error("Escolha uma data dentro dos próximos " + CONFIG.diasAFrente + " dias.");
}
function timeToMinutes_(time) {
  const m = String(time).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}
function minutesToTime_(n) { return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0"); }
function service_(name) {
  const s = CONFIG.servicos.find(x => x.nome === name);
  if (!s) throw new Error("Serviço inválido. Atualize a página e escolha um serviço disponível.");
  if (Number(s.minutos) <= 0 || Number(s.preco) < 0) throw new Error("Configuração de serviço inválida.");
  return s;
}
function allBookings_() {
  const sh = ensureSheets_().bookings;
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, BOOKING_HEADERS.length).getDisplayValues().map(r => ({
    id: r[0], data: r[1], hora: r[2], servico: r[3], minutos: Number(r[4]), nome: r[5],
    telefone: r[6], status: r[7], criado: r[8]
  })).filter(x => x.id);
}
function blockedDates_() {
  const sh = ensureSheets_().blocks;
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().flat().filter(Boolean);
}
function isBlocked_(date) { return blockedDates_().indexOf(date) !== -1; }
function overlaps_(startA, endA, startB, endB) { return startA < endB && startB < endA; }
function availableSlots_(date, serviceName) {
  validateDateRange_(date);
  const service = service_(serviceName);
  const hours = CONFIG.horarios[String(dateDay_(date))];
  if (!hours || !hours.aberto || isBlocked_(date)) return [];
  const open = timeToMinutes_(hours.abre), close = timeToMinutes_(hours.fecha);
  const duration = Number(service.minutos), step = Number(CONFIG.passoMin);
  if (open < 0 || close <= open || step <= 0) throw new Error("Horários de funcionamento estão configurados incorretamente.");
  const existing = allBookings_().filter(b => b.data === date && b.status !== "cancelado").map(b => {
    const start = timeToMinutes_(b.hora); return { start: start, end: start + Number(b.minutos) };
  });
  const slots = [];
  const nowStr = Utilities.formatDate(new Date(), CONFIG.timezone, "HH:mm");
  const nowMins = timeToMinutes_(nowStr);
  for (let start = open; start + duration <= close; start += step) {
    if (date === today_() && start <= nowMins) continue;
    const end = start + duration;
    if (existing.some(b => overlaps_(start, end, b.start, b.end))) continue;
    slots.push(minutesToTime_(start));
  }
  return slots;
}
function slots_(date, serviceName) {
  return { ok: true, slots: availableSlots_(date, serviceName) };
}
function book_(input) {
  const date = String(input.data || ""), time = String(input.hora || "");
  const service = service_(String(input.servico || ""));
  const name = String(input.nome || "").trim();
  const phone = String(input.telefone || "").trim();
  if (name.length < 2 || name.length > 100) throw new Error("Confira seu nome: informe pelo menos 2 caracteres.");
  if (phone.replace(/\D/g, "").length < 10 || phone.replace(/\D/g, "").length > 15) throw new Error("Confira seu telefone com DDD.");
  validateDateRange_(date);
  if (timeToMinutes_(time) < 0) throw new Error("Horário inválido.");
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Revalida a disponibilidade dentro do lock para evitar reservas duplicadas.
    const available = availableSlots_(date, service.nome);
    if (available.indexOf(time) === -1) throw new Error("Esse horário acabou de ser reservado. Escolha outro.");
    const sh = ensureSheets_().bookings;
    const id = Utilities.getUuid();
    const created = Utilities.formatDate(new Date(), CONFIG.timezone, "yyyy-MM-dd HH:mm:ss");
    // Datas/horas como texto para o Sheets não alterar o formato.
    sh.appendRow(["'" + id, "'" + date, "'" + time, service.nome, Number(service.minutos), name, phone, "pendente", "'" + created]);
    return { ok: true, agendamento: { id: id, data: date, hora: time, servico: service.nome, minutos: service.minutos, nome: name, telefone: phone, status: "pendente", preco: service.preco } };
  } finally {
    lock.releaseLock();
  }
}
function listBookings_(date) {
  // O painel pode consultar datas passadas para histórico; apenas exige data válida.
  if (!validDate_(date)) throw new Error("Data inválida.");
  const bookings = allBookings_().filter(b => b.data === date).sort((a, b) => a.hora.localeCompare(b.hora)).map(b => {
    const s = CONFIG.servicos.find(x => x.nome === b.servico);
    b.preco = s ? Number(s.preco) : 0;
    return b;
  });
  return { ok: true, data: date, bloqueado: isBlocked_(date), agendamentos: bookings };
}
function setStatus_(id, status) {
  if (!id) throw new Error("ID do agendamento ausente.");
  if (["confirmado", "cancelado"].indexOf(status) === -1) throw new Error("Status inválido.");
  const sh = ensureSheets_().bookings;
  if (sh.getLastRow() < 2) throw new Error("Agendamento não encontrado.");
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().flat().map(x => x.replace(/^'/, ""));
  const idx = ids.indexOf(id);
  if (idx < 0) throw new Error("Agendamento não encontrado.");
  sh.getRange(idx + 2, 8).setValue(status);
  return { ok: true, id: id, status: status };
}
function setBlocked_(date, blocked) {
  validateDateRange_(date);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = ensureSheets_().blocks;
    const dates = blockedDates_();
    if (blocked && dates.indexOf(date) === -1) sh.appendRow(["'" + date]);
    if (!blocked && dates.indexOf(date) !== -1) {
      for (let i = sh.getLastRow(); i >= 2; i--) {
        if (sh.getRange(i, 1).getDisplayValue().replace(/^'/, "") === date) sh.deleteRow(i);
      }
    }
    return { ok: true, data: date, bloqueado: blocked };
  } finally { lock.releaseLock(); }
}

/**
 * Execute setup() uma vez pelo editor para autorizar e criar as abas.
 */
function setup() {
  ensureSheets_();
  return "Abas Agendamentos e Bloqueios prontas.";
}

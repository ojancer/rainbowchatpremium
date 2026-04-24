// Mantém estado por ticket para evitar varreduras e alertas repetidos.
const ticketStates = new Map(); // ticketId -> { lastDatetime, lastMinute, lastType, notifiedBands:Set<string> }

const REFRESH_DEBOUNCE_MS = 250;
const TIME_REFRESH_MS = 5_000; // 5 segundos.

const ALERT_BANDS = {
    YELLOW: 'yellow',
    BLUE: 'blue',
    RED: 'red',
};

// Áudio embutido (sem dependência de rede): usa Web Audio API para gerar um alerta curto.
let audioContext = null;
let audioPrimed = false;

function getAudioContext() {
    if (!audioContext) {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return null;
        audioContext = new AudioContextCtor();
    }
    return audioContext;
}

async function primeAudio() {
    if (audioPrimed) return;
    audioPrimed = true;
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        try {
            await ctx.resume();
        } catch {
            // Pode falhar sem interação do usuário; será tentado novamente.
            audioPrimed = false;
        }
    }
}

// Tenta "desbloquear" áudio no primeiro gesto do usuário para aumentar a chance do alerta tocar.
function setupAudioPriming() {
    const handler = () => {
        primeAudio();
        window.removeEventListener('pointerdown', handler, true);
        window.removeEventListener('keydown', handler, true);
    };
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('keydown', handler, true);
}
setupAudioPriming();


function applyStylesToLastElement() {
    const logDivs = document.querySelectorAll('section[role="feed"]');
    const seenTicketIds = new Set();

    logDivs.forEach(logDiv => {
        
        const ticketTab = logDiv.closest('.conversation-polaris');
        const ticketTabId = ticketTab?.getAttribute('data-ticket-id');
        if (!ticketTabId) return;
        seenTicketIds.add(ticketTabId);

        const tab = document.querySelector(
            `[data-test-id="header-tab"][data-entity-id="${ticketTabId}"]`
        );
        if (!tab) return;

        const timing = getConversationTiming(logDiv, ticketTabId);
        if (!timing) return;
        checkTimestamp(timing.referenceDatetime, ticketTabId, tab, timing.lastType);
    

    });

    // Limpa estado de tickets que não estão mais presentes (evita crescimento infinito).
    for (const ticketId of ticketStates.keys()) {
        if (!seenTicketIds.has(ticketId)) ticketStates.delete(ticketId);
    }
}

function normalizeMessageType(type) {
    if (!type) return 'other';
    return type;
}

function getDatetimeFromContainer(container) {
    if (!container) return null;
    const relativeTimes = container.querySelectorAll('time[data-test-id="timestamp-relative"]');
    for (let index = relativeTimes.length - 1; index >= 0; index--) {
        const normalized = getNormalizedDatetimeFromTimeElement(relativeTimes[index]);
        if (normalized) return normalized;
    }

    const absoluteTimes = container.querySelectorAll('time[data-test-id="timestamp-absolute"]');
    for (let index = absoluteTimes.length - 1; index >= 0; index--) {
        const normalized = getNormalizedDatetimeFromTimeElement(absoluteTimes[index]);
        if (normalized) return normalized;
    }

    const times = container.querySelectorAll('time[datetime]');
    for (let index = times.length - 1; index >= 0; index--) {
        const normalized = getNormalizedDatetimeFromTimeElement(times[index]);
        if (normalized) return normalized;
    }

    return null;
}

function getLastTimestampElement(feedRoot) {
    const times = feedRoot.querySelectorAll(
        'time[data-test-id="timestamp-relative"], time[data-test-id="timestamp-absolute"]'
    );
    for (let index = times.length - 1; index >= 0; index--) {
        const candidate = times[index];
        if (candidate?.getAttribute('datetime')) return candidate;
    }
    return null;
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function getDisplayedHHMMFromTimeElement(timeEl) {
    if (!timeEl) return null;
    const aria = timeEl.getAttribute?.('aria-label')?.trim() || '';
    if (/^\d{1,2}:\d{2}$/.test(aria)) {
        const [hours, minutes] = aria.split(':');
        return `${pad2(hours)}:${minutes}`;
    }

    const text = timeEl.textContent?.trim() || '';
    if (/^\d{1,2}:\d{2}$/.test(text)) {
        const [hours, minutes] = text.split(':');
        return `${pad2(hours)}:${minutes}`;
    }

    return null;
}

function getHHMMFromDatetimeString(datetimeString) {
    const match = String(datetimeString || '').match(/T(\d{2}):(\d{2})/);
    if (!match) return null;
    return `${match[1]}:${match[2]}`;
}

function getNormalizedDatetimeFromTimeElement(timeEl) {
    if (!timeEl) return null;
    const datetime = timeEl.getAttribute?.('datetime')?.trim() || '';
    if (!datetime) return null;

    const testId = timeEl.getAttribute?.('data-test-id') || '';
    if (testId !== 'timestamp-absolute') return datetime;

    // Heurística para corrigir "fake Z" (hora local marcada como UTC):
    // Ex.: datetime="2026-04-24T14:49:39.626Z" exibindo "14:49" em GMT-03.
    const displayedHHMM = getDisplayedHHMMFromTimeElement(timeEl);
    const datetimeHHMM = getHHMMFromDatetimeString(datetime);
    if (!displayedHHMM || !datetimeHHMM) return datetime;

    const parsed = new Date(datetime);
    if (Number.isNaN(parsed.getTime())) return datetime;
    const localHHMM = `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;

    // Se o Zendesk está exibindo o HH:MM igual ao HH:MM do datetime, mas esse HH:MM
    // NÃO bate com o horário local que esse datetime (com Z/offset) representa,
    // então esse sufixo de timezone provavelmente está incorreto.
    if (displayedHHMM === datetimeHHMM && displayedHHMM !== localHHMM) {
        return datetime.replace(/(Z|[+-]\d{2}:?\d{2})$/i, '');
    }

    return datetime;
}

function parseZendeskDatetime(datetimeString) {
    if (!datetimeString || typeof datetimeString !== 'string') return null;
    let value = datetimeString.trim();
    if (!value) return null;

    // Normaliza formatos comuns que variam entre renderizações do Zendesk/browser:
    // - "YYYY-MM-DD HH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss" (evita parse como UTC em alguns browsers)
    // - timezone sem ":" no final: "-0300"/"+0000" -> "-03:00"/"+00:00"
    // - sufixo " UTC" -> "Z"
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) value = value.replace(' ', 'T');
    value = value.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3');
    value = value.replace(/\s*UTC$/, 'Z');

    const hasExplicitTimezone = /([+-]\d{2}:\d{2}|Z)$/i.test(value);

    // Se não houver timezone explícito, faz parse manual em horário local para evitar
    // diferenças de interpretação entre browsers (ex.: tratar como UTC e gerar +180 min).
    if (!hasExplicitTimezone) {
        const match = value.match(
            /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
        );
        if (match) {
            const year = Number(match[1]);
            const month = Number(match[2]) - 1;
            const day = Number(match[3]);
            const hour = Number(match[4]);
            const minute = Number(match[5]);
            const second = match[6] ? Number(match[6]) : 0;
            const millisecond = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
            const local = new Date(year, month, day, hour, minute, second, millisecond);
            if (Number.isNaN(local.getTime())) return null;
            return local;
        }
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function getConversationTiming(feedRoot, ticketId) {
    const messageElements = [...feedRoot.querySelectorAll('article [data-test-id="omni-log-item-message"]')];
    if (messageElements.length === 0) return null;

    const entries = messageElements.map(messageElement => {
        const type = normalizeMessageType(messageElement?.getAttribute?.('type'));
        const container = messageElement.closest('article') || messageElement.parentElement;
        const datetime = getDatetimeFromContainer(container);
        return { type, datetime, el: messageElement };
    });

    // Se alguns itens não tiverem datetime no container, tenta mapear por ordem no DOM
    // usando o último <time> que aparece antes de cada mensagem.
    if (entries.some(entry => !entry.datetime)) {
        const timeElements = [...feedRoot.querySelectorAll(
            'time[data-test-id="timestamp-relative"], time[data-test-id="timestamp-absolute"]'
        )]
            .map(timeEl => ({ el: timeEl, datetime: getNormalizedDatetimeFromTimeElement(timeEl) }))
            .filter(item => !!item.datetime);

        let timeIndex = 0;
        let lastDatetimeSeen = null;

        for (const entry of entries) {
            while (
                timeIndex < timeElements.length &&
                (timeElements[timeIndex].el.compareDocumentPosition(entry.el) & Node.DOCUMENT_POSITION_FOLLOWING)
            ) {
                lastDatetimeSeen = timeElements[timeIndex].datetime;
                timeIndex++;
            }
            if (!entry.datetime && lastDatetimeSeen) entry.datetime = lastDatetimeSeen;
        }
    }

    // Resolve o tipo da última mensagem (é isso que define as regras de cor/alerta).
    const lastMessageEl = messageElements[messageElements.length - 1];
    const lastType = normalizeMessageType(lastMessageEl?.getAttribute?.('type') || checkType(ticketId));

    // Se ainda não houver datetime em nenhum item, usa fallback seguro (mantém comportamento anterior).
    const anyDatetime = entries.some(entry => !!entry.datetime);
    if (!anyDatetime) {
        const lastTimeEl = getLastTimestampElement(feedRoot);
        const fallbackDatetime = lastTimeEl?.getAttribute?.('datetime') || null;
        if (!fallbackDatetime) return null;
        return { referenceDatetime: fallbackDatetime, lastType };
    }

    // Define o datetime "do relógio".
    // Se a última mensagem NÃO for do end-user, usa o timestamp da última msg.
    if (lastType !== 'end-user') {
        const lastDatetime = entries[entries.length - 1].datetime
            || [...entries].reverse().find(entry => entry.datetime)?.datetime
            || null;
        if (!lastDatetime) return null;
        return { referenceDatetime: lastDatetime, lastType };
    }

    // Se a última mensagem for end-user, usa o timestamp da PRIMEIRA msg do end-user
    // após a última msg "do suporte" (qualquer tipo != end-user).
    let lastNonEndUserIndex = -1;
    for (let index = entries.length - 1; index >= 0; index--) {
        if (normalizeMessageType(entries[index].type) !== 'end-user') {
            lastNonEndUserIndex = index;
            break;
        }
    }

    const startIndex = Math.max(0, lastNonEndUserIndex + 1);
    for (let index = startIndex; index < entries.length; index++) {
        if (normalizeMessageType(entries[index].type) === 'end-user' && entries[index].datetime) {
            return { referenceDatetime: entries[index].datetime, lastType };
        }
    }

    // Deve ser raro, mas garante retorno.
    const fallbackEndUserDatetime =
        entries[startIndex]?.datetime
        || entries[entries.length - 1].datetime
        || [...entries].reverse().find(entry => entry.datetime)?.datetime
        || null;
    if (!fallbackEndUserDatetime) return null;
    return { referenceDatetime: fallbackEndUserDatetime, lastType };
}

function checkTimestamp(referenceDatetime, id, tab, messageType) {
    if (!referenceDatetime || !id || !tab) return;
    const date = parseZendeskDatetime(referenceDatetime);
    if (!date) return;
    const now = new Date();
    const diff = now - date;
    const diffMinutes = Math.max(0, diff / (1000 * 60));
    const minuteFloor = Math.floor(diffMinutes);

    const state = ticketStates.get(id) ?? {
        lastReferenceDatetime: null,
        lastMinute: null,
        lastType: null,
        notifiedBands: new Set(),
    };

    const datetimeChanged = state.lastReferenceDatetime !== referenceDatetime;
    const minuteChanged = state.lastMinute !== minuteFloor;
    const typeChanged = state.lastType !== messageType;

    if (datetimeChanged) {
        state.notifiedBands.clear();
        state.lastReferenceDatetime = referenceDatetime;
    }

    if (minuteChanged || datetimeChanged) {
        state.lastMinute = minuteFloor;
        changeTime(tab, diffMinutes);
    }

    if (minuteChanged || datetimeChanged || typeChanged) {
        state.lastType = messageType;
        changeBackgroundColor(tab, id, messageType, diffMinutes, state);
    }

    ticketStates.set(id, state);
}

function changeTime(tab, time) {
    if (!tab) return;

    // Pega a primeira div dentro da tab (container do ícone)
    const iconContainer = tab.querySelector('div');
    if (!iconContainer) return;

    // Adiciona uma margem à direita para separar do restante das informações
    iconContainer.style.marginRight = "10px";

    // Remove o SVG caso ele ainda esteja presente
    const svg = iconContainer.querySelector('svg');
    if (svg) svg.remove();

    let spanTempo = iconContainer.querySelector('span.minhaClasse');
    if (!spanTempo) {
        spanTempo = document.createElement("span");
        spanTempo.className = "minhaClasse";
        spanTempo.style.margin = "12px";
        spanTempo.style.color = "black";
        spanTempo.style.fontWeight = "bold";
        // Adicionando um pequeno espaçamento e arredondamento para a cor de fundo ficar como um ícone (badge)
        spanTempo.style.padding = "2px 6px";
        spanTempo.style.borderRadius = "4px";
        iconContainer.appendChild(spanTempo);
    }
    
    spanTempo.textContent = Math.floor(time);
}


function checkType(id) {
        const conversationDiv = document.querySelector(`div[data-side-conversations-anchor-id="${id}"]`);
        const section = conversationDiv?.querySelector('section');
        const lastMessage = section
            ? [...section.querySelectorAll('article [data-test-id="omni-log-item-message"]')].pop()
            : null;
        return lastMessage?.getAttribute('type');
    }




function getAlertBand(type, diffMinutes) {
    if (diffMinutes >= 10) return ALERT_BANDS.RED;
    if (diffMinutes >= 5 && diffMinutes < 10 && type === "agent") return ALERT_BANDS.BLUE;
    if (diffMinutes >= 1 && diffMinutes < 10 && type === "end-user") return ALERT_BANDS.YELLOW;
    return null;
}

function changeBackgroundColor(tab, id, type, diffMinutes, state) {
    if (!tab) return;

    // Pega a primeira div dentro da tab (mesmo container usado no changeTime)
    const iconContainer = tab.querySelector('div');
    if (!iconContainer) return;

    const band = getAlertBand(type, diffMinutes);

    let alertColor = '';
    if (band === ALERT_BANDS.RED) alertColor = 'rgba(255, 0, 0, 0.64)';
    if (band === ALERT_BANDS.BLUE) alertColor = 'rgba(0, 60, 255, 0.67)';
    if (band === ALERT_BANDS.YELLOW) alertColor = 'rgba(255, 196, 0, 0.78)';

    // Som 1x por "faixa" desde a última mensagem (e permite tocar de novo quando chegar
    // uma nova mensagem e o datetime mudar).
    if (band && state && !state.notifiedBands.has(band)) {
        playSound();
        state.notifiedBands.add(band);
    }
    
    iconContainer.style.background = alertColor;
    // Aplica o mesmo border-radius da aba em todos os cantos para manter o padrão visual
    iconContainer.style.borderRadius = window.getComputedStyle(tab).borderTopLeftRadius;
}



function playSound() {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        if (ctx.state === 'suspended') {
            // Sem gesto do usuário, pode não tocar. O priming tenta resolver isso.
            primeAudio();
            if (ctx.state === 'suspended') return;
        }

        const now = ctx.currentTime;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

        const osc1 = ctx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, now);
        osc1.connect(gain);

        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(660, now + 0.12);
        osc2.connect(gain);

        gain.connect(ctx.destination);

        osc1.start(now);
        osc1.stop(now + 0.18);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.36);

        // Limpeza
        osc1.onended = () => {
            try { osc1.disconnect(); } catch {}
        };
        osc2.onended = () => {
            try { osc2.disconnect(); } catch {}
            try { gain.disconnect(); } catch {}
        };
    } catch {
        // Ignora falhas de autoplay/políticas do browser.
    }
}




applyStylesToLastElement();

let refreshTimer = null;
function scheduleRefreshSoon() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        applyStylesToLastElement();
    }, REFRESH_DEBOUNCE_MS);
}

// Atualiza o tempo com baixa frequência + atualiza rápido quando o DOM muda (nova mensagem/tab).
setInterval(applyStylesToLastElement, TIME_REFRESH_MS);

const observer = new MutationObserver(() => scheduleRefreshSoon());
observer.observe(document.body, { childList: true, subtree: true });

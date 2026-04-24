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
    const times = container.querySelectorAll(
        'time[data-test-id="timestamp-relative"], time[data-test-id="timestamp-absolute"]'
    );
    for (let index = times.length - 1; index >= 0; index--) {
        const candidate = times[index];
        const datetime = candidate?.getAttribute?.('datetime');
        if (datetime) return datetime;
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
        )].filter(timeEl => timeEl?.getAttribute?.('datetime'));

        let timeIndex = 0;
        let lastDatetimeSeen = null;

        for (const entry of entries) {
            while (
                timeIndex < timeElements.length &&
                (timeElements[timeIndex].compareDocumentPosition(entry.el) & Node.DOCUMENT_POSITION_FOLLOWING)
            ) {
                lastDatetimeSeen = timeElements[timeIndex].getAttribute('datetime');
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
    const date = new Date(referenceDatetime);
    if (Number.isNaN(date.getTime())) return;
    const now = new Date();
    const diff = now - date;
    const diffMinutes = diff / (1000 * 60);    
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

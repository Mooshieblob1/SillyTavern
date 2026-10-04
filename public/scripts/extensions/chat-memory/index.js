import {
    chat,
    chat_metadata,
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    name1,
    saveMetadata,
    saveSettingsDebounced,
    this_chid,
} from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { selected_group } from '../../group-chats.js';
import { getCharaFilename, getSanitizedFilename } from '../../utils.js';
import {
    METADATA_KEY,
    charSetAuxWorlds,
    createWorldInfoEntry,
    loadWorldInfo,
    openWorldInfoEditor,
    reloadEditor,
    saveWorldInfo,
    updateWorldInfoList,
    world_info,
    world_info_position,
    world_names,
} from '../../world-info.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';

const MODULE = 'chatMemory';
// Per-chat progress: index of the first message not yet processed
const META_KEY = 'chat_memory';
const MEMORY_COMMENT_PREFIX = 'Memory:';
// Messages sent to NovelAI per extraction request
const CHUNK_MESSAGES = 30;
const CHUNK_CHARS = 16000;
// Existing memories shown to the model so it doesn't repeat them
const MAX_EXISTING = 120;

const defaultSettings = {
    auto: true,
    interval: 6,
    scope: 'auto',
    model: 'xialong-v1',
    showButton: true,
    notify: true,
};

let running = false;

function settings() {
    return extension_settings[MODULE];
}

function getCharacterName() {
    return this_chid !== undefined ? characters[this_chid]?.name : '';
}

/**
 * Creates an empty lorebook without switching the World Info editor to it.
 * @param {string} name Lorebook name
 */
async function ensureBook(name) {
    if (!world_names.includes(name)) {
        await saveWorldInfo(name, { entries: {} }, true);
        await updateWorldInfoList();
    }
}

/**
 * A lorebook is shared if it's active globally or is any character's main lorebook.
 * @param {string} name Lorebook name
 */
function isSharedBook(name) {
    return !!world_info.globalSelect?.includes(name)
        || characters.some(c => c?.data?.extensions?.world === name);
}

/**
 * Chat memories live in the chat-bound lorebook. If the chat already has one, it is reused.
 * @param {boolean} create Create and bind a lorebook if the chat has none
 * @returns {Promise<string|null>} Lorebook name
 */
async function getChatBook(create) {
    const existing = chat_metadata[METADATA_KEY];
    if (existing && isSharedBook(existing)) {
        // Never write chat events into curated lore that other chats or characters use
        if (create) {
            throw new Error(`This chat's lorebook slot holds "${existing}", which is shared. Unbind it from the chat or save to the character instead.`);
        }
        return null;
    }
    if (existing || !create) {
        return existing || null;
    }

    // Chat IDs already start with the character name
    const name = await getSanitizedFilename(`Memory - ${getCurrentChatId()}`);
    await ensureBook(name);
    chat_metadata[METADATA_KEY] = name;
    await saveMetadata();
    return name;
}

/**
 * Character memories live in an extra lorebook linked to the character, shared by all their chats.
 * Not available in group chats.
 * @param {boolean} create Create and link the lorebook if missing
 * @returns {Promise<string|null>} Lorebook name
 */
async function getCharacterBook(create) {
    if (selected_group || this_chid === undefined) {
        return null;
    }

    const name = await getSanitizedFilename(`Memory - ${getCharacterName()}`);
    if (!create && !world_names.includes(name)) {
        return null;
    }

    await ensureBook(name);
    const fileName = getCharaFilename(this_chid);
    const linked = world_info.charLore?.find(e => e.name === fileName)?.extraBooks ?? [];
    if (!linked.includes(name)) {
        charSetAuxWorlds(fileName, [...linked, name]);
    }
    return name;
}

/**
 * @param {(string|null)[]} books Lorebook names
 * @returns {Promise<string[]>} Contents of enabled entries
 */
async function getExistingMemories(books) {
    const texts = [];
    for (const book of books.filter(Boolean)) {
        const data = await loadWorldInfo(book);
        for (const entry of Object.values(data?.entries ?? {})) {
            if (!entry.disable && entry.content?.trim()) {
                texts.push(entry.content.trim());
            }
        }
    }
    return texts.slice(-MAX_EXISTING);
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalize(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Splits chat messages into request-sized chunks, skipping hidden messages.
 * @param {number} from First message index
 * @param {number} to End index (exclusive)
 * @returns {{ lines: string[], end: number }[]} Chunks with the index each one ends at
 */
function getChunks(from, to) {
    const chunks = [];
    let lines = [];
    let chars = 0;
    for (let i = from; i < to; i++) {
        const message = chat[i];
        if (!message || message.is_system || !message.mes?.trim()) {
            continue;
        }
        const line = `${message.name}: ${message.mes.trim()}`;
        if (lines.length && (lines.length >= CHUNK_MESSAGES || chars + line.length > CHUNK_CHARS)) {
            chunks.push({ lines, end: i });
            lines = [];
            chars = 0;
        }
        lines.push(line);
        chars += line.length;
    }
    if (lines.length) {
        chunks.push({ lines, end: to });
    }
    return chunks;
}

function buildPrompt(lines, existing, askScope) {
    const charName = selected_group ? 'the characters' : getCharacterName();
    const system = [
        'You maintain long-term memory for an ongoing roleplay. Read the new messages and list facts worth remembering later: events that happened, decisions and promises, changes in relationships, items gained or lost, injuries, revealed secrets, and new details about characters or places.',
        `${name1} is the user's character. ${charName} ${selected_group ? 'are' : 'is'} played by the AI.`,
        'Rules:',
        '- Only include things that actually happened or were stated in the new messages. Never invent or infer beyond them.',
        '- Be precise about who did what and who has what. An offer that was refused or not acted on did not happen. If unsure, leave it out.',
        '- Skip anything already in the existing memories.',
        '- Skip trivial moment-to-moment actions and dialogue that has no lasting consequence.',
        '- Each memory is one short, self-contained sentence in past tense, using character names (never "I" or "you").',
        askScope ? '- scope "character" = a lasting fact about a character that should carry over to other storylines (personality, background, preferences, body). scope "chat" = an event or state specific to this storyline.' : '',
        '- Use plain punctuation. No em dashes.',
        askScope
            ? 'Reply with only a JSON array, like [{"text": "...", "scope": "chat"}]. Reply [] if nothing is worth remembering.'
            : 'Reply with only a JSON array, like [{"text": "..."}]. Reply [] if nothing is worth remembering.',
    ].filter(Boolean).join('\n');

    const user = [
        'Existing memories:',
        existing.length ? existing.map(m => `- ${m}`).join('\n') : '(none)',
        '',
        'New messages:',
        lines.join('\n'),
    ].join('\n');

    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * Asks NovelAI for new memories.
 * @returns {Promise<{ text: string, scope: string }[]>}
 */
async function extractMemories(lines, existing, askScope) {
    const response = await fetch('/api/novelai/chat-completion', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            model: settings().model,
            messages: buildPrompt(lines, existing, askScope),
            max_tokens: 800,
            temperature: 0.3,
            ban_ai_punctuation: true,
        }),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error?.message || `HTTP ${response.status}`);
    }

    const { output } = await response.json();
    const json = String(output ?? '');
    const parsed = JSON.parse(json.slice(json.indexOf('['), json.lastIndexOf(']') + 1));
    if (!Array.isArray(parsed)) {
        throw new Error('NovelAI did not return a list');
    }

    return parsed
        .filter(m => typeof m?.text === 'string' && m.text.trim())
        .map(m => ({ text: m.text.trim(), scope: m.scope === 'character' ? 'character' : 'chat' }));
}

/**
 * Appends memories to a lorebook as constant entries, in chronological order.
 * @param {string} book Lorebook name
 * @param {string[]} texts Memory texts
 */
async function addToBook(book, texts) {
    if (!book || !texts.length) {
        return;
    }

    // loadWorldInfo returns the shared cache; work on a copy
    const data = structuredClone(await loadWorldInfo(book) ?? { entries: {} });
    const orders = Object.values(data.entries).map(e => Number(e.order) || 0);
    let order = Math.max(100, ...orders);

    for (const text of texts) {
        const entry = createWorldInfoEntry(book, data);
        if (!entry) {
            continue;
        }
        Object.assign(entry, {
            comment: `${MEMORY_COMMENT_PREFIX} ${text.length > 60 ? text.slice(0, 57) + '...' : text}`,
            content: text,
            key: [],
            constant: true,
            position: world_info_position.after,
            order: ++order,
            addMemo: true,
        });
    }

    await saveWorldInfo(book, data, true);
    reloadEditor(book);
}

/**
 * Resolves where a memory goes. Group chats always use the chat lorebook.
 * @param {string} scopeSetting 'auto' | 'chat' | 'character'
 * @param {string} memoryScope Scope suggested by the model
 */
function getDestination(scopeSetting, memoryScope) {
    if (selected_group) {
        return 'chat';
    }
    return scopeSetting === 'auto' ? memoryScope : scopeSetting;
}

function setStatus(text) {
    $('#chat_memory_status').text(text);
}

/**
 * Extracts and saves memories from messages that haven't been processed yet.
 * @param {object} options
 * @param {boolean} [options.manual] Include the latest messages (auto mode leaves the last exchange for swipes)
 * @param {string} [options.scope] Override the scope setting
 * @param {boolean} [options.quiet] Don't show notifications
 * @returns {Promise<string>} Result summary
 */
async function runMemory({ manual = false, scope = null, quiet = false } = {}) {
    if (running) {
        if (manual && !quiet) toastr.info('Memory is already being updated.');
        return '';
    }

    const chatId = getCurrentChatId();
    if (!chatId || !chat.length) {
        return '';
    }

    const meta = chat_metadata[META_KEY] ?? (chat_metadata[META_KEY] = { lastIndex: 0 });
    // Messages were deleted since the last run
    if (meta.lastIndex > chat.length) {
        meta.lastIndex = chat.length;
    }

    const end = manual ? chat.length : Math.max(0, chat.length - 2);
    const chunks = getChunks(meta.lastIndex, end);
    if (!chunks.length) {
        if (manual && !quiet) toastr.info('No new messages to remember.');
        return '';
    }

    const scopeSetting = scope || settings().scope;
    const saved = [];
    running = true;
    $('#chat_memory_button').addClass('chat_memory_running');
    setStatus('Updating memory...');

    try {
        for (const chunk of chunks) {
            const existing = await getExistingMemories([await getChatBook(false), await getCharacterBook(false)]);
            const known = new Set(existing.map(normalize));
            const memories = (await extractMemories(chunk.lines, existing, scopeSetting === 'auto' && !selected_group))
                .filter(m => !known.has(normalize(m.text)));

            // The user switched chats while waiting; don't write into the wrong one
            if (getCurrentChatId() !== chatId) {
                return '';
            }

            const toChat = memories.filter(m => getDestination(scopeSetting, m.scope) === 'chat').map(m => m.text);
            const toCharacter = memories.filter(m => getDestination(scopeSetting, m.scope) === 'character').map(m => m.text);
            if (toChat.length) await addToBook(await getChatBook(true), toChat);
            if (toCharacter.length) await addToBook(await getCharacterBook(true), toCharacter);

            saved.push(...memories);
            meta.lastIndex = chunk.end;
            await saveMetadata();
        }

        const summary = saved.length ? `Remembered ${saved.length}: ${saved.map(m => m.text).join(' | ')}` : 'Nothing new to remember.';
        setStatus(saved.length ? `Last update: ${saved.length} new memories.` : 'Last update: nothing new.');
        if (!quiet && saved.length && settings().notify) {
            toastr.info(saved.map(m => escapeHtml(m.text)).join('<br>'), `Remembered ${saved.length}`);
        } else if (!quiet && manual && !saved.length) {
            toastr.info('Nothing new to remember.');
        }
        return summary;
    } catch (error) {
        console.error('[Chat Memory] Update failed', error);
        setStatus(`Last update failed: ${error.message}`);
        if (!quiet) toastr.warning(String(error.message), 'Memory update failed');
        return '';
    } finally {
        running = false;
        $('#chat_memory_button').removeClass('chat_memory_running');
    }
}

/**
 * Saves text as a memory directly, without asking the model.
 */
async function saveDirect(text, scope) {
    if (!getCurrentChatId()) {
        return '';
    }
    const scopeSetting = scope || settings().scope;
    const destination = getDestination(scopeSetting === 'auto' ? 'chat' : scopeSetting, 'chat');
    const book = destination === 'character' ? await getCharacterBook(true) : await getChatBook(true);
    await addToBook(book, [text.trim()]);
    if (settings().notify) toastr.info(text.trim(), 'Remembered');
    return `Saved to ${book}`;
}

function onMessageReceived() {
    if (!settings().auto || running || !getCurrentChatId()) {
        return;
    }
    const lastIndex = chat_metadata[META_KEY]?.lastIndex ?? 0;
    const settled = chat.length - 2;
    if (settled - lastIndex >= settings().interval) {
        // Let the reply finish rendering first
        setTimeout(() => runMemory({ quiet: !settings().notify }), 500);
    }
}

function updateButton() {
    $('#chat_memory_button').toggle(!!settings().showButton);
}

function loadSettingsUi() {
    const s = settings();
    $('#chat_memory_auto').prop('checked', s.auto);
    $('#chat_memory_interval').val(s.interval);
    $('#chat_memory_scope').val(s.scope);
    $('#chat_memory_model').val(s.model);
    $('#chat_memory_show_button').prop('checked', s.showButton);
    $('#chat_memory_notify').prop('checked', s.notify);
}

async function openBook(getBook) {
    const book = await getBook(false);
    if (book) {
        openWorldInfoEditor(book);
    } else {
        toastr.info('No memories saved there yet.');
    }
}

export async function init() {
    extension_settings[MODULE] = Object.assign({}, defaultSettings, extension_settings[MODULE]);

    const html = await renderExtensionTemplateAsync('chat-memory', 'settings');
    $('#extensions_settings2').append(html);
    loadSettingsUi();

    $('#chat_memory_auto').on('input', function () {
        settings().auto = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#chat_memory_interval').on('input', function () {
        settings().interval = Math.min(Math.max(Number($(this).val()) || defaultSettings.interval, 2), 50);
        saveSettingsDebounced();
    });
    $('#chat_memory_scope').on('change', function () {
        settings().scope = String($(this).val());
        saveSettingsDebounced();
    });
    $('#chat_memory_model').on('change', function () {
        settings().model = String($(this).val());
        saveSettingsDebounced();
    });
    $('#chat_memory_show_button').on('input', function () {
        settings().showButton = !!$(this).prop('checked');
        updateButton();
        saveSettingsDebounced();
    });
    $('#chat_memory_notify').on('input', function () {
        settings().notify = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#chat_memory_run').on('click', () => runMemory({ manual: true }));
    $('#chat_memory_open_chat').on('click', () => openBook(getChatBook));
    $('#chat_memory_open_char').on('click', () => openBook(getCharacterBook));

    // Quick button next to Send, beside the Impersonate button
    const button = $('<div id="chat_memory_button" class="fa-solid fa-brain interactable" title="Remember now: save new events from this chat" tabindex="0"></div>');
    button.on('click', () => runMemory({ manual: true }));
    $('#mes_impersonate').before(button);
    updateButton();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'remember',
        callback: async (args, text) => {
            const scope = ['chat', 'character', 'auto'].includes(String(args?.scope)) ? String(args.scope) : null;
            return String(text ?? '').trim()
                ? await saveDirect(String(text), scope)
                : await runMemory({ manual: true, scope });
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'scope',
                description: 'where to save: chat, character, or auto (let NovelAI decide)',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['chat', 'character', 'auto'],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to save as a memory directly (optional)', [ARGUMENT_TYPE.STRING], false),
        ],
        helpString: 'Saves new events and facts from this chat as memories using NovelAI. With text, saves that text as a memory directly.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}

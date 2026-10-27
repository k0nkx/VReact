import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { before, after, instead } from '@valenced/patcher'
import { getAssetIdByName } from '@valenced/assets'
import { findInReactTree } from '@valenced/utils/tree'
import { React, ReactNative } from '@valenced/react'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'

/**
 * VReactions — Valenced port of SReact / Reactions.
 * Preset reaction spam via long-press menu and chat commands.
 * Stops on 429. Same behaviour as the original Vendetta plugin.
 */

interface Preset {
    id: string
    name: string
    emojis: string
}

interface Settings {
    presets: Preset[]
    prefix: string
    censor: boolean
    censorWords: string
    silentDelete: boolean
    delay: string
    lastRun?: string
    emojis?: string
}

const MAX_REACTIONS = 20
const DEFAULT_CENSOR = 'job work working shower soap employed'
const DEFAULT_EMOJIS = '😂 💀 🔥 😭 👍 👎 ❤️ 😈 🤡 💯 👀 🙏 😎 🤔 🥶 🤯 😡 🎉 🫡 🗿'

function newId() {
    return Math.random().toString(36).slice(2, 10)
}

function plain(p: any): Preset {
    return { id: p?.id, name: p?.name, emojis: p?.emojis }
}

export default plugin<{ jsonStorage: Settings }>({
    jsonStorage: {
        load: true,
        default: {
            presets: [{ id: 'default', name: 'Spam Reactions', emojis: DEFAULT_EMOJIS }],
            prefix: ';',
            censor: false,
            censorWords: DEFAULT_CENSOR,
            silentDelete: false,
            delay: '400',
        },
    },

    start({ cleanup, jsonStorage, logger }) {
        const storage = jsonStorage.cache!
        // Ensure presets always have unique ids
        {
            const used = new Set<string>()
            storage.presets = (storage.presets ?? []).map(plain).map(pr => {
                let id = pr.id
                if (!id || used.has(id)) id = newId()
                used.add(id)
                return { ...pr, id }
            })
            jsonStorage.set({ presets: storage.presets })
        }

        const showToast = (msg: string) => {
            try { logger.log('Reaction Spam: ' + String(msg ?? '')) } catch {}
        }

        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

        // ---- Module lookups ------------------------------------------------
        let RestAPI: any
        let ActionSheet: any
        let MessageStore: any
        let ChannelStore: any
        let EmojiStore: any
        let GuildStore: any

        const [rest] = lookupModule(withProps('getAPIBaseURL', 'get', 'put'))
        RestAPI = rest
        if (!RestAPI) {
            const [rest2] = lookupModule(withProps('getAPIBaseURL', 'put'))
            RestAPI = rest2
        }
        if (!RestAPI) logger.error('Reaction Spam: could not find REST API module')

        const [sheet] = lookupModule(withProps('openLazy', 'hideActionSheet'))
        ActionSheet = sheet

        try {
            MessageStore = Stores.MessageStore
            ChannelStore = Stores.ChannelStore
        } catch {}

        let running = false
        let cancelled = false
        const restEmojis: any[] = []
        const restFetchedGuilds = new Set<string>()
        const missingShortcodes: string[] = []

        // ---- Emoji helpers (same logic as original) ------------------------

        const isEmoji = (e: any) =>
            e && typeof e === 'object' && typeof e.id === 'string' && typeof e.name === 'string'
            && !('ownerId' in e) && ('animated' in e || 'guildId' in e || 'require_colons' in e || 'allNamesString' in e)

        async function loadRestEmojis() {
            if (!RestAPI?.get) return
            const wanted = missingShortcodes.map(n => n.toLowerCase())
            const found = () => wanted.every(n => restEmojis.some(e => e.name.toLowerCase() === n))
            try {
                const res = await RestAPI.get({ url: '/users/@me/guilds' })
                for (const g of res?.body ?? []) {
                    if (found()) break
                    if (!g?.id || restFetchedGuilds.has(g.id)) continue
                    restFetchedGuilds.add(g.id)
                    try {
                        const r = await RestAPI.get({ url: `/guilds/${g.id}/emojis` })
                        for (const e of r?.body ?? []) {
                            if (typeof e?.id === 'string' && typeof e?.name === 'string') restEmojis.push(e)
                        }
                    } catch (e) {
                        logger.error('Reaction Spam: could not load emojis for a server', e)
                    }
                    await sleep(100)
                }
            } catch (e) {
                logger.error('Reaction Spam: could not load servers emojis', e)
            }
        }

        function customEmojiList() {
            const list: any[] = []
            const seenIds = new Set<string>()
            let visited = 0
            const collect = (v: any, depth: number) => {
                if (!v || typeof v !== 'object' || visited++ > 20000) return
                if (isEmoji(v)) {
                    if (!seenIds.has(v.id)) { seenIds.add(v.id); list.push(v) }
                    return
                }
                if (depth <= 0) return
                const items = v instanceof Map ? [...v.values()] : Array.isArray(v) ? v : Object.values(v)
                for (const it of items) collect(it, depth - 1)
            }
            const attempt = (fn: () => any) => { try { collect(fn(), 3) } catch {} }

            try {
                if (!EmojiStore) {
                    const [es] = lookupModule(withProps('getCustomEmojiById', 'getGuilds'))
                    EmojiStore = es
                }
                GuildStore ??= Stores.GuildStore
                const es = EmojiStore
                if (es) {
                    attempt(() => es.getGuilds?.())
                    attempt(() => es.getDisambiguatedEmojiContext?.()?.customEmojis)
                    attempt(() => es.getUsableCustomEmojis?.())
                    attempt(() => es.getCustomEmojis?.())
                    try {
                        const guilds = GuildStore?.getGuilds?.() ?? {}
                        for (const id of Object.keys(guilds)) {
                            attempt(() => es.getGuildEmoji?.(id))
                            attempt(() => guilds[id]?.emojis)
                        }
                    } catch {}
                }
            } catch (e) {
                logger.error('Reaction Spam: could not read emoji store', e)
            }
            for (const e of restEmojis) {
                if (!seenIds.has(e.id)) { seenIds.add(e.id); list.push(e) }
            }
            return list.sort((a, b) => (b.available !== false ? 1 : 0) - (a.available !== false ? 1 : 0))
        }

        function resolveShortcode(name: string, getList: () => any[]) {
            const list = getList()
            const lower = name.toLowerCase()
            const hit = list.find(e => e.name === name) ?? list.find(e => e.name.toLowerCase() === lower)
            if (!hit) {
                if (!missingShortcodes.includes(name)) missingShortcodes.push(name)
                logger.error(`Reaction Spam: no custom emoji named :${name}: (yet)`)
            }
            return hit ? `${hit.name}:${hit.id}` : null
        }

        function splitEmoji(str: string) {
            const cps = Array.from(str)
            const isMod = (c: string) => {
                const n = c.codePointAt(0)!
                return n === 0xFE0F || n === 0xFE0E || n === 0x20E3
                    || (n >= 0x1F3FB && n <= 0x1F3FF) || (n >= 0xE0020 && n <= 0xE007F)
            }
            const isFlag = (c: string) => {
                const n = c.codePointAt(0)!
                return n >= 0x1F1E6 && n <= 0x1F1FF
            }
            const out: string[] = []
            let i = 0
            while (i < cps.length) {
                let g = cps[i++]
                if (isFlag(g) && i < cps.length && isFlag(cps[i])) g += cps[i++]
                while (i < cps.length) {
                    if (isMod(cps[i])) g += cps[i++]
                    else if (cps[i] === '\u200D' && i + 1 < cps.length) { g += cps[i] + cps[i + 1]; i += 2 }
                    else break
                }
                out.push(g)
            }
            return out
        }

        function parseEmojis(raw: string) {
            const out: { key: string; isCustom: boolean }[] = []
            const seen = new Set<string>()
            let cache: any[] | undefined
            missingShortcodes.length = 0
            const getList = () => (cache ??= customEmojiList())
            const tokens = String(raw ?? '').match(/<a?:\w+:\d+>|\w+:\d+|[^\s,]+/g) ?? []
            for (const t of tokens) {
                const custom = t.match(/^<?a?:?(\w+):(\d+)>?$/)
                const short = t.match(/^:(\w+):$/)
                const keys = custom
                    ? [`${custom[1]}:${custom[2]}`]
                    : short
                        ? [resolveShortcode(short[1], getList)]
                        : /[^\x00-\x7F]/.test(t) ? splitEmoji(t) : [t]
                for (const key of keys) {
                    if (!key || seen.has(key)) continue
                    seen.add(key)
                    out.push({ key, isCustom: !!(custom || short) })
                }
            }
            if (out.length > MAX_REACTIONS) {
                let room = MAX_REACTIONS - out.filter(o => o.isCustom).length
                return out.filter(o => o.isCustom || room-- > 0).slice(0, MAX_REACTIONS).map(o => o.key)
            }
            return out.map(o => o.key)
        }

        // ---- Reacting ------------------------------------------------------

        function addReaction(channelId: string, messageId: string, emoji: string) {
            return RestAPI.put({
                url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
                query: { location: 'Message Reaction Picker', type: 0 },
            })
        }

        function errorStatus(e: any) {
            return e?.status ?? e?.statusCode ?? e?.response?.status ?? e?.body?.status
        }

        function errorText(e: any) {
            const status = errorStatus(e)
            const msg = e?.body?.message ?? e?.message ?? (typeof e === 'string' ? e : '')
            return [status, msg].filter(Boolean).join(' ') || 'unknown error'
        }

        async function spam(message: { id: string; channel_id: string }, preset: Preset) {
            if (running) return showToast('Reaction spam already running')
            if (!RestAPI?.put) return showToast("Couldn't find Discord's REST API")
            if (!preset) return showToast('That preset no longer exists')

            let emojis = parseEmojis(preset.emojis)
            if (missingShortcodes.length) {
                await loadRestEmojis()
                emojis = parseEmojis(preset.emojis)
            }
            const last = `${preset.name || 'preset'}: ${emojis.length ? emojis.join(' ') : 'nothing to react with'}`
                + (missingShortcodes.length ? ` (not found: ${missingShortcodes.map(n => ':' + n + ':').join(' ')})` : '')
            jsonStorage.set({ lastRun: last })
            if (!emojis.length) return showToast('Add some emojis to this preset in the plugin settings first')

            const delay = Math.max(0, parseInt(storage.delay, 10) || 0)
            running = true
            cancelled = false
            let sent = 0
            let failed = 0
            let lastError: any = null

            try {
                for (const emoji of emojis) {
                    if (cancelled) break
                    try {
                        await addReaction(message.channel_id, message.id, emoji)
                        sent++
                    } catch (e) {
                        const status = errorStatus(e)
                        if (status === 429) {
                            showToast(`Rate limited (429), stopped after ${sent} reaction(s)`)
                            return { sent, failed }
                        }
                        if (status === 401 || status === 403) {
                            showToast(`No permission to react (${status}), stopped`)
                            return { sent, failed }
                        }
                        failed++
                        lastError = e
                        logger.error('Reaction Spam: failed to add', emoji, e)
                    }
                    if (delay) await sleep(delay)
                }
                if (cancelled) showToast(`Stopped after ${sent} reaction(s)`)
                else if (!sent && lastError) showToast(`Added 0, all ${failed} failed: ${errorText(lastError)}`)
                else showToast(`Added ${sent}/${emojis.length} reaction(s)${failed ? `, ${failed} failed (${errorText(lastError)})` : ''}`)
                return { sent, failed }
            } catch (e) {
                logger.error('Reaction Spam:', e)
                showToast('Reaction spam failed, check logs')
                return { sent, failed }
            } finally {
                running = false
            }
        }

        // ---- Chat commands -------------------------------------------------

        const norm = (str: string) => String(str ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

        function similarity(a: string, b: string) {
            if (!a.length || !b.length) return 0
            let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
            for (let i = 1; i <= a.length; i++) {
                const cur = [i]
                for (let j = 1; j <= b.length; j++) {
                    cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
                }
                prev = cur
            }
            return 1 - prev[b.length] / Math.max(a.length, b.length)
        }

        function findClosestPreset(query: string) {
            const q = norm(query)
            if (!q) return null
            let best: Preset | null = null
            let bestScore = 0
            for (const raw of storage.presets ?? []) {
                const preset = plain(raw)
                const n = norm(preset.name)
                if (!n) continue
                const score = n === q ? 1
                    : (n.startsWith(q) || q.startsWith(n)) ? 0.9
                    : (n.includes(q) || q.includes(n)) ? 0.75
                    : similarity(n, q)
                if (score > bestScore) { best = preset; bestScore = score }
            }
            return bestScore >= 0.5 ? best : null
        }

        const recentFromStore = (channelId: string, limit: number) => {
            try {
                MessageStore ??= Stores.MessageStore
                const col = MessageStore?.getMessages?.(channelId)
                const arr = col?.toArray?.() ?? col?._array ?? []
                return arr.slice(-limit).reverse()
            } catch (e) {
                logger.error('Reaction Spam: message store lookup failed', e)
                return []
            }
        }

        async function fetchRecent(channelId: string, limit: number, skipId?: string) {
            try {
                const query: any = { limit: Math.min(100, Math.max(1, limit)) }
                if (skipId) query.before = skipId
                const res = await RestAPI.get({ url: `/channels/${channelId}/messages`, query })
                if (Array.isArray(res?.body)) return res.body
            } catch (e) {
                logger.error('Reaction Spam: could not fetch recent messages', e)
            }
            return recentFromStore(channelId, limit + 1).filter((m: any) => m?.id !== skipId).slice(0, limit)
        }

        async function findLatestMessage(channelId: string, userId: string, skipId?: string) {
            const local = recentFromStore(channelId, 200).find((m: any) => m?.author?.id === userId && m.id !== skipId)
            if (local) return local
            return (await fetchRecent(channelId, 100, skipId)).find((m: any) => m?.author?.id === userId) ?? null
        }

        async function withRetry(fn: () => Promise<any>, tries = 3) {
            let last: any
            for (let i = 0; i < tries; i++) {
                try { return await fn() } catch (e) {
                    last = e
                    if (errorStatus(e) === 429) await sleep(1000 * (i + 1))
                    else break
                }
            }
            throw last
        }

        async function locateMessageChannel(currentChannelId: string, messageId: string) {
            try {
                ChannelStore ??= Stores.ChannelStore
                MessageStore ??= Stores.MessageStore
            } catch {}

            const ids = [currentChannelId]
            try {
                const guildId = ChannelStore?.getChannel?.(currentChannelId)?.guild_id
                if (guildId) {
                    let chans: any[] = []
                    try {
                        const m = ChannelStore.getMutableGuildChannelsForGuild?.(guildId)
                        if (m) chans = Object.values(m)
                    } catch {}
                    if (!chans.length) {
                        try { chans = (await RestAPI.get({ url: `/guilds/${guildId}/channels` }))?.body ?? [] } catch {}
                    }
                    const isAnn = (c: any) => c.type === 5 || /announce|news/i.test(c.name ?? '')
                    chans = chans.filter(c => c && (c.type === 0 || c.type === 5) && c.id !== currentChannelId)
                        .sort((a, b) => (isAnn(b) ? 1 : 0) - (isAnn(a) ? 1 : 0))
                    for (const c of chans) ids.push(c.id)
                }
            } catch (e) {
                logger.error('Reaction Spam: could not list server channels', e)
            }

            for (const cid of ids) {
                try { if (MessageStore?.getMessage?.(cid, messageId)) return cid } catch {}
            }

            const gap = Math.max(150, Math.min(500, parseInt(storage.delay, 10) || 0))
            for (const cid of ids.slice(0, 150)) {
                try {
                    const res = await withRetry(() => RestAPI.get({ url: `/channels/${cid}/messages/${messageId}` }))
                    if (res?.body?.id === messageId) return cid
                } catch {}
                await sleep(gap)
            }
            return null
        }

        async function removeMyReactions(messages: any[], channelId: string) {
            let removed = 0
            for (const m of messages) {
                for (const r of m.reactions ?? []) {
                    if (!r?.me) continue
                    const emoji = r.emoji?.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji?.name
                    if (!emoji) continue
                    try {
                        await RestAPI.del?.({ url: `/channels/${channelId}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}/@me` })
                            ?? RestAPI.delete?.({ url: `/channels/${channelId}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}/@me` })
                        removed++
                        const delay = Math.max(0, parseInt(storage.delay, 10) || 0)
                        if (delay) await sleep(delay)
                    } catch (e) {
                        logger.error('Reaction Spam: failed to remove reaction', e)
                    }
                }
            }
            return removed
        }

        const userName = (id: string) => {
            try {
                const u = Stores.UserStore?.getUser?.(id)
                return u?.username ?? id
            } catch { return id }
        }

        async function runWithStatus(channelId: string, shownText: string, job: (skipId?: string) => Promise<string>) {
            let sentId: string | undefined
            try {
                const res = await RestAPI.post({
                    url: `/channels/${channelId}/messages`,
                    body: { content: shownText },
                })
                sentId = res?.body?.id
            } catch (e) {
                logger.error('Reaction Spam: could not post status message', e)
            }
            let result = 'failed'
            try {
                result = await job(sentId)
            } catch (e) {
                logger.error('Reaction Spam: command job failed', e)
            }
            if (sentId) {
                try {
                    await RestAPI.patch?.({ url: `/channels/${channelId}/messages/${sentId}`, body: { content: result } })
                        ?? RestAPI.put?.({ url: `/channels/${channelId}/messages/${sentId}`, body: { content: result } })
                    await sleep(2000)
                    await (RestAPI.del ?? RestAPI.delete).call(RestAPI, { url: `/channels/${channelId}/messages/${sentId}` })
                } catch (e) {
                    logger.error('Reaction Spam: could not update/delete status message', e)
                }
            }
        }

        function censorWordList() {
            return String(storage.censorWords ?? DEFAULT_CENSOR).split(/\s+/).filter(Boolean)
        }

        function censorText(text: string) {
            const words = censorWordList().sort((a, b) => b.length - a.length)
            if (!words.length) return text
            const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            let out = text
            for (const w of words) {
                const re = new RegExp(escape(w), 'gi')
                out = out.replace(re, m => m.replace(/o/gi, '█'))
            }
            return out
        }

        function handleCommand(channelId: string, content: string) {
            const prefix = storage.prefix || ';'
            if (typeof content !== 'string' || !content.startsWith(prefix)) return false
            const body = content.slice(prefix.length)

            const undoUser = body.match(/^\s*undo\s+<@!?(\d+)>\s*$/i)
            const undoCount = body.match(/^\s*undo(?:\s+(\d{1,3}))?\s*$/i)
            const meCmd = body.match(/^\s*me\s+(\d{1,3})(?:\s+(silent|normal))?\s*$/i)
            const censorCmd = body.match(/^\s*(un)?censor\s*$/i)
            const spamCmd = body.match(/^\s*([\w -]+?)\s+<@!?(\d+)>\s*$/)
            const spamIdCmd = body.match(/^\s*([\w -]+?)\s+(\d{15,22})\s*$/)

            let job: ((skipId?: string) => Promise<string>) | null = null

            if (undoUser) {
                const userId = undoUser[1]
                job = async skipId => {
                    const msgs = await fetchRecent(channelId, 50, skipId)
                    const target = msgs.find((m: any) => m?.author?.id === userId && (m.reactions ?? []).some((r: any) => r?.me))
                    if (!target) return 'nothing to undo'
                    const removed = await removeMyReactions([target], channelId)
                    jsonStorage.set({ lastRun: `undo @${userName(userId)}: removed ${removed} reaction(s)` })
                    return removed > 0 ? 'finished' : 'failed'
                }
            } else if (undoCount) {
                const n = Math.min(100, Math.max(1, parseInt(undoCount[1], 10) || 1))
                job = async skipId => {
                    const msgs = (await fetchRecent(channelId, n, skipId)).slice(0, n)
                    const mine = msgs.filter((m: any) => (m?.reactions ?? []).some((r: any) => r?.me))
                    if (!mine.length) return 'nothing to undo'
                    const removed = await removeMyReactions(mine, channelId)
                    jsonStorage.set({ lastRun: `undo ${n}: removed ${removed} reaction(s) from ${mine.length} message(s)` })
                    return removed > 0 ? 'finished' : 'failed'
                }
            } else if (spamCmd) {
                const [, query, userId] = spamCmd
                job = async skipId => {
                    const preset = findClosestPreset(query)
                    if (!preset) {
                        jsonStorage.set({ lastRun: `Command "${query.trim()}": no preset with a similar name` })
                        return 'no matching preset'
                    }
                    const target = await findLatestMessage(channelId, userId, skipId)
                    if (!target) {
                        jsonStorage.set({ lastRun: `${preset.name}: couldn't find a recent message from that person` })
                        return 'no recent message found'
                    }
                    const result = await spam({ id: target.id, channel_id: target.channel_id ?? channelId }, preset)
                    return result && result.sent > 0 ? 'finished' : 'failed'
                }
            } else if (spamIdCmd) {
                const [, query, messageId] = spamIdCmd
                job = async () => {
                    const preset = findClosestPreset(query)
                    if (!preset) {
                        jsonStorage.set({ lastRun: `Command "${query.trim()}": no preset with a similar name` })
                        return 'no matching preset'
                    }
                    const targetChannel = await locateMessageChannel(channelId, messageId)
                    if (!targetChannel) {
                        jsonStorage.set({ lastRun: `${preset.name}: couldn't find message ${messageId} in this server` })
                        return 'message not found'
                    }
                    const result = await spam({ id: messageId, channel_id: targetChannel }, preset)
                    return result && result.sent > 0 ? 'finished' : 'failed'
                }
            } else if (meCmd) {
                const n = Math.min(500, Math.max(1, parseInt(meCmd[1], 10) || 1))
                const mode = (meCmd[2] || (storage.silentDelete ? 'silent' : 'normal')).toLowerCase()
                job = skipId => purgeMine(channelId, n, mode, skipId)
            } else if (censorCmd) {
                const on = !censorCmd[1]
                jsonStorage.set({ censor: on })
                showToast(on ? 'Censor on' : 'Censor off')
                return true
            } else {
                return false
            }

            const shown = content.replace(/<@!?(\d+)>/g, (_, id) => '@' + userName(id))
            runWithStatus(channelId, shown, job!)
            return true
        }

        async function collectMyMessages(channelId: string, n: number, startBefore?: string) {
            const out: any[] = []
            let before = startBefore
            const me = Stores.UserStore?.getCurrentUser?.()?.id
            while (out.length < n) {
                const batch = await fetchRecent(channelId, Math.min(100, n - out.length + 5), before)
                if (!batch.length) break
                for (const m of batch) {
                    if (m?.author?.id === me) out.push(m)
                    if (out.length >= n) break
                }
                before = batch[batch.length - 1]?.id
                if (!before) break
            }
            return out.slice(0, n)
        }

        const deleteMessage = (channelId: string, messageId: string) =>
            (RestAPI.del ?? RestAPI.delete).call(RestAPI, { url: `/channels/${channelId}/messages/${messageId}` })

        async function silentDeleteMessage(channelId: string, messageId: string) {
            try {
                await withRetry(() => RestAPI.post({
                    url: `/channels/${channelId}/messages`,
                    body: { content: '\u200b', message_reference: { message_id: messageId, channel_id: channelId } },
                }))
            } catch {}
            await sleep(1500)
            await deleteMessage(channelId, messageId)
        }

        async function purgeMine(channelId: string, n: number, mode: string, skipId?: string) {
            const msgs = await collectMyMessages(channelId, n, skipId)
            let deleted = 0
            for (const m of msgs) {
                try {
                    if (mode === 'silent') await silentDeleteMessage(channelId, m.id)
                    else await deleteMessage(channelId, m.id)
                    deleted++
                    const delay = Math.max(0, parseInt(storage.delay, 10) || 0)
                    if (delay) await sleep(delay)
                } catch (e) {
                    logger.error('Reaction Spam: purge failed', e)
                }
            }
            jsonStorage.set({ lastRun: `me ${n} ${mode}: deleted ${deleted}/${msgs.length}` })
            return deleted > 0 ? 'finished' : 'failed'
        }

        // ---- Patch send (commands + censor) --------------------------------

        function patchSend() {
            const [MessageActions] = lookupModule(withProps('sendMessage', 'editMessage'))
            if (!MessageActions?.sendMessage) {
                logger.error('Reaction Spam: could not find MessageActions')
                return
            }
            cleanup(
                before(MessageActions, 'sendMessage', (args: any[]) => {
                    const channelId = args[0]
                    const msg = args[1]
                    if (!msg || typeof msg.content !== 'string') return args
                    if (handleCommand(channelId, msg.content)) {
                        // swallow the original send
                        args[1] = { ...msg, content: '' }
                        // still let it through but empty; better to instead-patch when possible
                        return args
                    }
                    if (storage.censor) {
                        msg.content = censorText(msg.content)
                    }
                    return args
                }),
            )
            // Stronger intercept: instead of sending empty, block command messages
            cleanup(
                instead(MessageActions, 'sendMessage', (args: any[], original: Function) => {
                    const channelId = args[0]
                    const msg = args[1]
                    if (msg && typeof msg.content === 'string' && handleCommand(channelId, msg.content)) {
                        return Promise.resolve({ ok: true })
                    }
                    if (msg && storage.censor && typeof msg.content === 'string') {
                        msg.content = censorText(msg.content)
                    }
                    return original(...args)
                }),
            )
        }

        // ---- Toast guard (same reason as original) -------------------------

        function patchToastGuard() {
            try {
                const [store] = lookupModule(withProps('open', 'close', 'getToasts'))
                const fn = store?.open ? 'open' : store?.openToast ? 'openToast' : null
                if (store && fn) {
                    cleanup(
                        instead(store, fn, (args: any[], orig: Function) => {
                            const t = args?.[0]
                            if (t && typeof t === 'object' && (t.position ?? t.options?.position) === undefined) return
                            return orig(...args)
                        }),
                    )
                }
            } catch (e) {
                logger.error('Reaction Spam: could not guard toasts', e)
            }
        }

        // ---- Long-press menu -----------------------------------------------

        const isRow = (el: any) => el?.props && typeof el.props.label === 'string' && typeof el.props.onPress === 'function'

        function makeRow(template: any, key: string, label: string, iconNames: string[], onPress: () => void) {
            const props: any = { key, label, onPress }
            const iconId = iconNames.map(n => getAssetIdByName?.(n)).find(Boolean)
            const icon = template.props.icon
            if (iconId && React.isValidElement(icon)) props.icon = React.cloneElement(icon, { source: iconId })
            else if (iconId && typeof icon === 'number') props.icon = iconId
            return React.cloneElement(template, props)
        }

        function addRow(tree: any, message: any) {
            const rows = findInReactTree(tree, (x: any) => Array.isArray(x) && x.some(isRow))
            if (!rows) return
            for (let i = rows.length - 1; i >= 0; i--) {
                if (typeof rows[i]?.key === 'string' && rows[i].key.startsWith('reaction-spam')) rows.splice(i, 1)
            }
            const template = rows.find(isRow)
            if (!template) return
            const icons = ['ic_add_reaction_24px', 'ReactionIcon', 'EmojiNewIcon', 'ic_emoji_24px']
            const hide = () => ActionSheet?.hideActionSheet?.()

            if (running) {
                rows.push(makeRow(template, 'reaction-spam-stop', 'Stop Reaction Spam', icons, () => {
                    hide()
                    cancelled = true
                    showToast('Stopping...')
                }))
                return
            }

            ;(storage.presets ?? []).map(plain).forEach((snap, i) => {
                rows.push(makeRow(template, `reaction-spam-${i}-${snap.id}`, snap.name || 'Spam Reactions', icons, () => {
                    hide()
                    const live = storage.presets?.[i]
                    spam(message, live ? plain(live) : snap)
                }))
            })
        }

        function patchSheet() {
            if (!ActionSheet) {
                logger.error('Reaction Spam: could not find action sheet module')
                return
            }
            cleanup(
                before(ActionSheet, 'openLazy', (args: any[]) => {
                    const [lazy, key] = args
                    if (typeof key !== 'string' || !key.includes('MessageLongPress')) return args
                    Promise.resolve(lazy).then((mod: any) => {
                        if (!mod) return
                        const target = typeof mod.default === 'function' ? mod
                            : typeof mod.default?.type === 'function' ? mod.default : null
                        const prop = typeof mod.default === 'function' ? 'default'
                            : typeof mod.default?.type === 'function' ? 'type' : null
                        if (!target || !prop) {
                            logger.error('Reaction Spam: unexpected message menu shape')
                            return
                        }
                        cleanup(
                            after(target, prop, (args: any[], tree: any) => {
                                try {
                                    if (args?.[0]?.message?.id) addRow(tree, args[0].message)
                                } catch (e) {
                                    logger.error('Reaction Spam: could not add menu button', e)
                                }
                                return tree
                            }),
                        )
                    })
                    return args
                }),
            )
        }

        patchToastGuard()
        patchSheet()
        patchSend()

        logger.log('VReactions started')
    },

    SettingsComponent({ api }) {
        const { Text, TextInput, View, Switch, TouchableOpacity, ScrollView } = ReactNative as any
        const settings = api.jsonStorage.use() as Settings | undefined
        if (!settings) return null

        const label = { color: '#ffffff', fontSize: 16, fontWeight: '600' as const, marginBottom: 6 }
        const hint = { color: '#b5bac1', fontSize: 13, marginTop: 6 }
        const input = {
            color: '#ffffff',
            backgroundColor: '#1e1f22',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 16,
        }
        const card = { backgroundColor: '#2b2d31', borderRadius: 12, padding: 14, gap: 12, marginBottom: 12 }

        const presets = (Array.isArray(settings.presets) ? settings.presets : []).map(plain)
        const update = (i: number, patch: Partial<Preset>) => {
            const next = presets.map((p, j) => j === i ? { ...p, ...patch } : p)
            api.jsonStorage.set({ presets: next })
        }
        const remove = (i: number) => {
            api.jsonStorage.set({ presets: presets.filter((_, j) => j !== i) })
        }
        const add = () => {
            api.jsonStorage.set({
                presets: [...presets, { id: newId(), name: 'New preset', emojis: '' }],
            })
        }

        const button = (text: string, onPress: () => void, color: string) =>
            React.createElement(TouchableOpacity, {
                onPress,
                style: { backgroundColor: color, borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginVertical: 4 },
            }, React.createElement(Text, { style: { color: '#ffffff', fontWeight: '600', fontSize: 15 } }, text))

        const presetCards = presets.map((p, i) =>
            React.createElement(View, { key: `${i}-${p.id}`, style: card },
                React.createElement(View, null,
                    React.createElement(Text, { style: label }, 'Button name'),
                    React.createElement(TextInput, {
                        style: input,
                        value: p.name ?? '',
                        placeholder: 'e.g. Flame Skull',
                        placeholderTextColor: '#80848e',
                        onChangeText: (v: string) => update(i, { name: v }),
                    }),
                ),
                React.createElement(View, null,
                    React.createElement(Text, { style: label }, 'Emojis (max 20)'),
                    React.createElement(TextInput, {
                        style: { ...input, minHeight: 80, textAlignVertical: 'top' },
                        multiline: true,
                        value: p.emojis ?? '',
                        placeholder: '😂 💀 🔥  or  :skullcry:  or  <:name:id>',
                        placeholderTextColor: '#80848e',
                        onChangeText: (v: string) => update(i, { emojis: v }),
                    }),
                ),
                button('Remove', () => remove(i), '#ed4245'),
            ),
        )

        return React.createElement(ScrollView, { style: { padding: 16 }, contentContainerStyle: { gap: 16 } },
            React.createElement(View, null,
                React.createElement(Text, { style: label }, 'Command prefix'),
                React.createElement(TextInput, {
                    style: input,
                    value: settings.prefix ?? ';',
                    placeholder: ';',
                    placeholderTextColor: '#80848e',
                    onChangeText: (v: string) => api.jsonStorage.set({ prefix: v.trim() }),
                }),
                React.createElement(Text, { style: hint },
                    'Commands: ";flame @someone" adds the closest-named preset to their latest message. '
                    + '";flame 1563682914397323414" targets that message ID in any channel of this server. '
                    + '";undo 10" / ";undo @someone". ";me 10" deletes your last 10 messages. '
                    + '";censor" / ";uncensor".'),
            ),
            React.createElement(View, null,
                React.createElement(View, { style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
                    React.createElement(Text, { style: { ...label, marginBottom: 0 } }, 'Auto-censor my messages'),
                    React.createElement(Switch, {
                        value: !!settings.censor,
                        onValueChange: (v: boolean) => api.jsonStorage.set({ censor: v }),
                    }),
                ),
                React.createElement(TextInput, {
                    style: { ...input, marginTop: 10 },
                    value: settings.censorWords ?? '',
                    placeholder: DEFAULT_CENSOR,
                    placeholderTextColor: '#80848e',
                    onChangeText: (v: string) => api.jsonStorage.set({ censorWords: v }),
                }),
                React.createElement(Text, { style: hint },
                    'Words to censor, separated by spaces. Each "o" becomes █.'),
            ),
            React.createElement(View, null,
                React.createElement(View, { style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
                    React.createElement(Text, { style: { ...label, marginBottom: 0 } }, 'Silent delete for ;me'),
                    React.createElement(Switch, {
                        value: !!settings.silentDelete,
                        onValueChange: (v: boolean) => api.jsonStorage.set({ silentDelete: v }),
                    }),
                ),
                React.createElement(Text, { style: hint },
                    'On = silent delete (placeholder then delete). Override with ";me 10 silent" or ";me 10 normal".'),
            ),
            ...presetCards,
            button('+ Add a new button', add, '#5865f2'),
            React.createElement(View, null,
                React.createElement(Text, { style: label }, 'Delay between reactions (ms)'),
                React.createElement(TextInput, {
                    style: input,
                    value: String(settings.delay ?? ''),
                    placeholder: '400',
                    placeholderTextColor: '#80848e',
                    keyboardType: 'numeric',
                    onChangeText: (v: string) => api.jsonStorage.set({ delay: v.replace(/[^0-9]/g, '') }),
                }),
                React.createElement(Text, { style: hint },
                    'Stops immediately on a 429. Raise the delay if you keep hitting it.'),
            ),
            settings.lastRun
                ? React.createElement(Text, { style: hint }, 'Last run: ' + settings.lastRun)
                : null,
        )
    },
})

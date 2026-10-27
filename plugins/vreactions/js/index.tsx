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

        async function runWithStatus(channelId: st

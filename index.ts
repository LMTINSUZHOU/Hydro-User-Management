import Schema from 'schemastery';
import {
    Context, db, DomainModel, Handler, param, PRIV, requireSudo,
    TokenModel, Types, UserModel, ValidationError,
} from 'hydrooj';

type Action = 'add' | 'delete' | 'update';
type RowStatus = 'dryrun' | 'error' | 'ok' | 'skipped';
type SearchBy = 'auto' | 'mail' | 'uid' | 'uname';

interface ParsedRow {
    line: number;
    data: Record<string, any>;
}

interface BatchOptions {
    cleanEffect?: boolean;
    domainId?: string;
    dryrun?: boolean;
    hardDelete?: boolean;
    ip?: string;
    report?: (payload: any) => void;
}

interface RowResult {
    line: number;
    mail?: string;
    message: string;
    status: RowStatus;
    uid?: number;
    uname?: string;
}

interface BatchResult {
    action: Action;
    dryrun: boolean;
    errors: number;
    messages: string[];
    rows: RowResult[];
    skipped: number;
    total: number;
    updated: number;
}

interface UserRow {
    avatar: string;
    bio: string;
    canEdit: boolean;
    displayName: string;
    gender: string;
    groups: string;
    join: boolean;
    loginat: Date;
    mail: string;
    priv: number;
    regat: Date;
    role: string;
    school: string;
    studentId: string;
    uid: number;
    uname: string;
}

interface UserQueryResult {
    limited: boolean;
    rows: UserRow[];
    total: number;
}

const DEFAULT_DOMAIN = 'system';
const DEFAULT_CREATE_HEADERS = ['mail', 'uname', 'password', 'displayName', 'school', 'studentId', 'uid', 'group'];
const DEFAULT_UPDATE_HEADERS = ['uid', 'mail', 'uname', 'password', 'displayName', 'school', 'studentId', 'priv', 'role', 'join', 'group'];
const DEFAULT_DELETE_HEADERS = ['uid'];
const DEFAULT_QUERY_LIMIT = 100;
const ACTIONS = new Set<Action>(['add', 'delete', 'update']);
const SEARCH_BY = new Set<SearchBy>(['auto', 'mail', 'uid', 'uname']);
const ALL_EDITABLE_PRIV = Object.entries(PRIV)
    .filter(([key, value]) => (
        typeof value === 'number'
        && !['PRIV_DEFAULT', 'PRIV_NEVER', 'PRIV_NONE', 'PRIV_ALL'].includes(key)
    ))
    .reduce((sum, [, value]) => sum + value as number, 0);
const BooleanType = Types.Boolean as any;
const ContentType = Types.Content as any;
const StringType = Types.String as any;

const KEY_ALIASES: Record<string, string> = {
    display: 'displayName',
    display_name: 'displayName',
    displayname: 'displayName',
    email: 'mail',
    groupName: 'group',
    groups: 'group',
    id: 'uid',
    name: 'uname',
    student_id: 'studentId',
    studentid: 'studentId',
    user: 'uid',
    username: 'uname',
};

const KNOWN_KEYS = new Set([
    'avatar', 'bio', 'displayName', 'gender', 'group', 'hardDelete', 'join',
    'mail', 'password', 'priv', 'role', 'school', 'studentId', 'uid', 'uname',
]);

const collDocument = db.collection('document');
const collDocumentStatus = db.collection('document.status');
const collDomainUser = db.collection('domain.user');
const collMessage = db.collection('message');
const collOauth = db.collection('oauth');
const collRecord = db.collection('record');

function normalizeKey(key: string) {
    const trimmed = key.trim();
    const compact = trimmed.replace(/[-\s]/g, '_');
    return KEY_ALIASES[trimmed] || KEY_ALIASES[compact] || compact;
}

function normalizeAction(action: string): Action {
    if (ACTIONS.has(action as Action)) return action as Action;
    throw new ValidationError('action');
}

function normalizeSearchBy(searchBy: any): SearchBy {
    if (SEARCH_BY.has(searchBy as SearchBy)) return searchBy as SearchBy;
    return 'auto';
}

function convertByType(type: any, value: any, field: string) {
    try {
        if (Array.isArray(type)) {
            if (type[1] && !type[1](value)) throw new Error();
            return type[0](value);
        }
        return type(value);
    } catch (e) {
        throw new Error(`Invalid ${field}: ${value}`);
    }
}

function parseBool(value: any) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    return !['false', 'off', 'no', '0'].includes(value.toString().trim().toLowerCase());
}

function parseUid(value: any, field = 'uid') {
    if (value === undefined || value === null || value === '') return undefined;
    const uid = +value;
    if (!Number.isSafeInteger(uid)) throw new Error(`Invalid ${field}: ${value}`);
    return uid;
}

function tryParseUid(value: any) {
    try {
        return parseUid(value);
    } catch (e) {
        return undefined;
    }
}

function parsePriv(value: any) {
    if (value === undefined || value === null || value === '') return undefined;
    const priv = +value;
    if (!Number.isSafeInteger(priv) || priv < 0 || priv === PRIV.PRIV_ALL || priv === ALL_EDITABLE_PRIV) {
        throw new Error(`Invalid priv: ${value}`);
    }
    return priv;
}

function parseGroups(value: any) {
    if (value === undefined || value === null || value === '') return [];
    return String(value).split(/[;,]/).map((i: string) => i.trim()).filter(Boolean);
}

function bodyValue(body: Record<string, any>, key: string) {
    return body[key] === undefined || body[key] === null ? '' : body[key].toString().trim();
}

function parseDelimitedLine(line: string, delimiter: string) {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') {
                current += '"';
                i++;
            } else quoted = !quoted;
        } else if (!quoted && ch === delimiter) {
            cells.push(current.trim());
            current = '';
        } else current += ch;
    }
    cells.push(current.trim());
    return cells;
}

function detectDelimiter(line: string) {
    const tabs = (line.match(/\t/g) || []).length;
    const commas = (line.match(/,/g) || []).length;
    return tabs > commas ? '\t' : ',';
}

function normalizeRecord(input: Record<string, any>, line: number): ParsedRow {
    const data: Record<string, any> = {};
    for (const [rawKey, rawValue] of Object.entries(input)) {
        const key = normalizeKey(rawKey);
        if (rawValue === undefined || rawValue === null) continue;
        const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
        if (value === '') continue;
        data[key] = value;
    }
    return { line, data };
}

function parsePairCells(cells: string[], line: number) {
    const data: Record<string, any> = {};
    for (const cell of cells) {
        const index = cell.indexOf('=');
        if (index === -1) continue;
        data[cell.slice(0, index).trim()] = cell.slice(index + 1).trim();
    }
    return normalizeRecord(data, line);
}

function parseRows(raw: string, defaultHeaders: string[]) {
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
        const data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error('JSON input must be an array.');
        return data.map((row, index) => normalizeRecord(row, index + 1));
    }
    if (text.split(/\r?\n/).every((line) => !line.trim() || line.trim().startsWith('{'))) {
        return text.split(/\r?\n/).map((line, index) => ({ line, index }))
            .filter(({ line }) => line.trim())
            .map(({ line, index }) => normalizeRecord(JSON.parse(line), index + 1));
    }

    const lines = text.split(/\r?\n/).map((line, index) => ({ line, index: index + 1 }))
        .filter(({ line }) => line.trim() && !line.trim().startsWith('#'));
    if (!lines.length) return [];

    const delimiter = detectDelimiter(lines[0].line);
    const firstCells = parseDelimitedLine(lines[0].line, delimiter);
    const hasHeader = firstCells.some((cell) => KNOWN_KEYS.has(normalizeKey(cell)));
    const headers = (hasHeader ? firstCells : defaultHeaders).map(normalizeKey);
    const dataLines = hasHeader ? lines.slice(1) : lines;

    return dataLines.map(({ line, index }) => {
        const cells = parseDelimitedLine(line, delimiter);
        if (cells.length && cells.every((cell) => cell.includes('='))) return parsePairCells(cells, index);
        const data: Record<string, any> = {};
        headers.forEach((header, i) => { data[header] = cells[i]; });
        return normalizeRecord(data, index);
    });
}

function createResult(action: Action, dryrun: boolean, total: number): BatchResult {
    return {
        action,
        dryrun,
        errors: 0,
        messages: [],
        rows: [],
        skipped: 0,
        total,
        updated: 0,
    };
}

function pushRow(result: BatchResult, row: RowResult, report?: (payload: any) => void) {
    result.rows.push(row);
    if (row.status === 'error') result.errors++;
    else if (row.status === 'skipped') result.skipped++;
    else result.updated++;
    report?.({ message: `Line ${row.line}: ${row.message}` });
}

function assertEditableUser(udoc: any) {
    if (!udoc || udoc._id <= 1 || udoc.priv === PRIV.PRIV_ALL) {
        throw new Error('Super admin or system user cannot be edited here.');
    }
}

async function resolveUser(domainId: string, row: Record<string, any>) {
    const uid = parseUid(row.uid);
    if (uid !== undefined) return await UserModel.getById(domainId, uid) || await UserModel.getById(DEFAULT_DOMAIN, uid);
    if (row.mail) return await UserModel.getByEmail(DEFAULT_DOMAIN, row.mail.toString());
    if (row.uname) return await UserModel.getByUname(DEFAULT_DOMAIN, row.uname.toString());
    throw new Error('Missing uid, mail, or uname.');
}

function rawUser(udoc: any) {
    return udoc?._udoc || udoc;
}

async function resolveSearchUsers(domainId: string, q: string, searchBy: SearchBy) {
    const value = q.trim();
    if (!value) return [];

    const results: any[] = [];
    const push = (udoc: any) => {
        const doc = rawUser(udoc);
        if (doc && !results.some((item) => rawUser(item)._id === doc._id)) results.push(udoc);
    };

    if (searchBy === 'uid' || searchBy === 'auto') {
        const uid = tryParseUid(value);
        if (uid !== undefined) push(await UserModel.getById(domainId, uid) || await UserModel.getById(DEFAULT_DOMAIN, uid));
        if (searchBy === 'uid') return results;
    }
    if (searchBy === 'mail' || (searchBy === 'auto' && value.includes('@'))) {
        push(await UserModel.getByEmail(DEFAULT_DOMAIN, value));
        if (searchBy === 'mail') return results;
    }
    if (searchBy === 'uname' || searchBy === 'auto') push(await UserModel.getByUname(DEFAULT_DOMAIN, value));
    return results;
}

function calcRole(udoc: any, dudoc: any) {
    if (!(udoc.priv & PRIV.PRIV_USER_PROFILE)) return 'guest';
    if (!dudoc?.join && !(udoc.priv & PRIV.PRIV_VIEW_ALL_DOMAIN)) return 'guest';
    if (udoc.priv & PRIV.PRIV_MANAGE_ALL_DOMAIN) return 'root';
    return dudoc?.role || 'default';
}

async function buildUserRows(domainId: string, input: any[]): Promise<UserRow[]> {
    const udocs = input.map(rawUser).filter(Boolean);
    const uids = udocs.map((udoc) => udoc._id);
    if (!uids.length) return [];

    const [dudocs, groups] = await Promise.all([
        DomainModel.getDomainUserMulti(domainId, uids).toArray(),
        UserModel.listGroup(domainId),
    ]);
    const domainByUid = new Map<number, any>();
    for (const dudoc of dudocs) domainByUid.set(dudoc.uid, dudoc);

    const groupsByUid = new Map<number, string[]>();
    for (const group of groups as any[]) {
        for (const uid of group.uids || []) {
            const current = groupsByUid.get(uid) || [];
            current.push(group.name);
            groupsByUid.set(uid, current);
        }
    }

    return udocs.map((udoc) => {
        const dudoc = domainByUid.get(udoc._id);
        return {
            avatar: udoc.avatar || '',
            bio: udoc.bio || '',
            canEdit: udoc._id > 1 && udoc.priv !== PRIV.PRIV_ALL,
            displayName: dudoc?.displayName || '',
            gender: udoc.gender === undefined ? '' : udoc.gender.toString(),
            groups: (groupsByUid.get(udoc._id) || []).join(';'),
            join: !!dudoc?.join,
            loginat: udoc.loginat,
            mail: udoc.mail,
            priv: udoc.priv,
            regat: udoc.regat,
            role: calcRole(udoc, dudoc),
            school: udoc.school || '',
            studentId: udoc.studentId || '',
            uid: udoc._id,
            uname: udoc.uname,
        };
    });
}

async function queryUsers(domainId: string, q: string, searchBy: SearchBy, limit?: number): Promise<UserQueryResult> {
    const value = q.trim();
    if (value) {
        const rows = await buildUserRows(domainId, await resolveSearchUsers(domainId, value, searchBy));
        return { limited: false, rows, total: rows.length };
    }

    const filter = { _id: { $gte: 1 } };
    const cursor = UserModel.getMulti(filter).sort({ _id: 1 });
    if (limit) cursor.limit(limit);
    const [udocs, total] = await Promise.all([
        cursor.toArray(),
        UserModel.coll.countDocuments(filter),
    ]);
    const rows = await buildUserRows(domainId, udocs);
    return { limited: !!limit && total > rows.length, rows, total };
}

function csvCell(value: any) {
    if (value === undefined || value === null) return '';
    const text = value instanceof Date ? value.toISOString() : value.toString();
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function usersToCsv(rows: UserRow[]) {
    const fields: Array<keyof UserRow> = [
        'uid', 'uname', 'mail', 'displayName', 'school', 'studentId',
        'role', 'join', 'priv', 'regat', 'loginat', 'groups', 'avatar', 'gender', 'bio',
    ];
    const lines = [
        fields.join(','),
        ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(',')),
    ];
    return `\uFEFF${lines.join('\n')}\n`;
}

async function assertCreateUnique(row: Record<string, any>, uid?: number) {
    const [mailUser, nameUser, uidUser] = await Promise.all([
        UserModel.getByEmail(DEFAULT_DOMAIN, row.mail),
        UserModel.getByUname(DEFAULT_DOMAIN, row.uname),
        uid === undefined ? Promise.resolve(null) : UserModel.getById(DEFAULT_DOMAIN, uid),
    ]);
    if (mailUser) throw new Error(`Email already exists: ${row.mail}`);
    if (nameUser) throw new Error(`Username already exists: ${row.uname}`);
    if (uidUser) throw new Error(`UID already exists: ${uid}`);
}

function collectGlobalPatch(row: Record<string, any>) {
    const patch: Record<string, any> = {};
    for (const key of ['avatar', 'bio', 'gender', 'school', 'studentId']) {
        if (row[key] !== undefined) patch[key] = row[key].toString();
    }
    return patch;
}

function collectDomainPatch(row: Record<string, any>) {
    const patch: Record<string, any> = {};
    if (row.displayName !== undefined) patch.displayName = row.displayName.toString();
    if (row.role !== undefined) patch.role = convertByType(Types.Role, row.role, 'role');
    const join = parseBool(row.join);
    if (join !== undefined) patch.join = join;
    return patch;
}

async function applyGroups(domainId: string, uid: number, groups: string[], dryrun: boolean) {
    if (!groups.length || dryrun) return;
    const currentGroups = await UserModel.listGroup(domainId);
    for (const name of groups) {
        const current = currentGroups.find((group: any) => group.name === name)?.uids || [];
        await UserModel.updateGroup(domainId, name, Array.from(new Set([...current, uid])));
    }
}

async function setGroups(domainId: string, uid: number, groups: string[]) {
    const wanted = new Set(groups);
    const currentGroups = await UserModel.listGroup(domainId);
    for (const group of currentGroups as any[]) {
        const current = group.uids || [];
        const hasUser = current.includes(uid);
        const shouldHaveUser = wanted.has(group.name);
        if (shouldHaveUser) wanted.delete(group.name);
        if (hasUser === shouldHaveUser) continue;
        const next = shouldHaveUser
            ? Array.from(new Set([...current, uid]))
            : current.filter((id: number) => id !== uid);
        await UserModel.updateGroup(domainId, group.name, next);
    }
    for (const name of wanted) await UserModel.updateGroup(domainId, name, [uid]);
}

async function updateQueriedUser(domainId: string, body: Record<string, any>) {
    const uid = parseUid(body.uid);
    if (uid === undefined) throw new Error('Missing uid.');
    const udoc = await UserModel.getById(domainId, uid) || await UserModel.getById(DEFAULT_DOMAIN, uid);
    if (!udoc) throw new Error('User not found.');
    assertEditableUser(udoc);

    const uname = convertByType(Types.Username, bodyValue(body, 'uname'), 'uname');
    const mail = convertByType(Types.Email, bodyValue(body, 'mail'), 'mail');
    const displayName = bodyValue(body, 'displayName');
    const school = bodyValue(body, 'school');
    const studentId = bodyValue(body, 'studentId');
    const roleInput = bodyValue(body, 'role') || 'default';
    const role = convertByType(Types.Role, roleInput, 'role');
    const groups = parseGroups(body.groups);
    const priv = parsePriv(body.priv);
    const password = bodyValue(body, 'password');
    const nextPassword = password ? convertByType(Types.Password, password, 'password') : undefined;
    if (priv === undefined) throw new Error('Missing priv.');

    if (mail !== udoc.mail) {
        const current = await UserModel.getByEmail(DEFAULT_DOMAIN, mail);
        if (current && current._id !== uid) throw new Error(`Email already exists: ${mail}`);
    }
    if (uname !== udoc.uname) {
        const current = await UserModel.getByUname(DEFAULT_DOMAIN, uname);
        if (current && current._id !== uid) throw new Error(`Username already exists: ${uname}`);
    }

    if (mail !== udoc.mail) await UserModel.setEmail(uid, mail);
    if (uname !== udoc.uname) await UserModel.setUname(uid, uname);
    if (nextPassword) await UserModel.setPassword(uid, nextPassword);
    if (priv !== udoc.priv) await UserModel.setPriv(uid, priv);
    await UserModel.setById(uid, { school, studentId } as any);
    await DomainModel.setUserInDomain(domainId, uid, { displayName, role });
    await setGroups(domainId, uid, groups);
    return uid;
}

async function addOne(row: ParsedRow, options: Required<Pick<BatchOptions, 'domainId' | 'dryrun' | 'ip'>>) {
    const mail = convertByType(Types.Email, row.data.mail, 'mail');
    const uname = convertByType(Types.Username, row.data.uname, 'uname');
    const password = convertByType(Types.Password, row.data.password, 'password');
    const uid = parseUid(row.data.uid);
    const priv = parsePriv(row.data.priv);
    if (uid !== undefined && uid <= 1) throw new Error('UID must be greater than 1.');
    await assertCreateUnique({ mail, uname }, uid);

    if (options.dryrun) {
        return { uid, mail, uname, message: `Will create user ${uname}.` };
    }

    const createdUid = await UserModel.create(mail, uname, password, uid, options.ip, priv);
    const globalPatch = collectGlobalPatch(row.data);
    const domainPatch = collectDomainPatch(row.data);
    if (Object.keys(globalPatch).length) await UserModel.setById(createdUid, globalPatch as any);
    if (Object.keys(domainPatch).length) await DomainModel.setUserInDomain(options.domainId, createdUid, domainPatch);
    await applyGroups(options.domainId, createdUid, parseGroups(row.data.group), false);
    return { uid: createdUid, mail, uname, message: `Created user ${createdUid} ${uname}.` };
}

async function updateOne(row: ParsedRow, options: Required<Pick<BatchOptions, 'domainId' | 'dryrun'>>) {
    const udoc = await resolveUser(options.domainId, row.data);
    if (!udoc) throw new Error('User not found.');
    assertEditableUser(udoc);

    const nextMail = row.data.mail === undefined ? undefined : convertByType(Types.Email, row.data.mail, 'mail');
    const nextUname = row.data.uname === undefined ? undefined : convertByType(Types.Username, row.data.uname, 'uname');
    const nextPassword = row.data.password === undefined ? undefined : convertByType(Types.Password, row.data.password, 'password');
    const nextPriv = parsePriv(row.data.priv);
    const globalPatch = collectGlobalPatch(row.data);
    const domainPatch = collectDomainPatch(row.data);
    const groups = parseGroups(row.data.group);

    if (nextMail && nextMail !== udoc.mail) {
        const current = await UserModel.getByEmail(DEFAULT_DOMAIN, nextMail);
        if (current && current._id !== udoc._id) throw new Error(`Email already exists: ${nextMail}`);
    }
    if (nextUname && nextUname !== udoc.uname) {
        const current = await UserModel.getByUname(DEFAULT_DOMAIN, nextUname);
        if (current && current._id !== udoc._id) throw new Error(`Username already exists: ${nextUname}`);
    }

    const changes = [
        nextMail ? 'mail' : '',
        nextUname ? 'uname' : '',
        nextPassword ? 'password' : '',
        nextPriv !== undefined ? 'priv' : '',
        ...Object.keys(globalPatch),
        ...Object.keys(domainPatch),
        ...groups.map((group) => `group:${group}`),
    ].filter(Boolean);

    if (!changes.length) {
        return { uid: udoc._id, mail: udoc.mail, uname: udoc.uname, message: 'No changes.', skipped: true };
    }
    if (options.dryrun) {
        return {
            uid: udoc._id,
            mail: nextMail || udoc.mail,
            uname: nextUname || udoc.uname,
            message: `Will update ${changes.join(', ')}.`,
        };
    }

    if (nextMail) await UserModel.setEmail(udoc._id, nextMail);
    if (nextUname) await UserModel.setUname(udoc._id, nextUname);
    if (nextPassword) await UserModel.setPassword(udoc._id, nextPassword);
    if (nextPriv !== undefined) await UserModel.setPriv(udoc._id, nextPriv);
    if (Object.keys(globalPatch).length) await UserModel.setById(udoc._id, globalPatch as any);
    if (Object.keys(domainPatch).length) await DomainModel.setUserInDomain(options.domainId, udoc._id, domainPatch);
    await applyGroups(options.domainId, udoc._id, groups, false);
    return {
        uid: udoc._id,
        mail: nextMail || udoc.mail,
        uname: nextUname || udoc.uname,
        message: `Updated ${changes.join(', ')}.`,
    };
}

async function cleanUserEffect(uid: number, hardDelete: boolean) {
    await Promise.all([
        collDocument.deleteMany({ owner: uid }),
        collDocumentStatus.deleteMany({ uid }),
        collRecord.deleteMany({ uid }),
        collDomainUser.deleteMany({ uid }),
        collMessage.deleteMany({ $or: [{ from: uid }, { to: uid }] }),
        collOauth.deleteMany({ uid }),
        TokenModel.delByUid(uid),
    ]);
    if (hardDelete) await UserModel.coll.deleteOne({ _id: uid });
    else await UserModel.setPriv(uid, PRIV.PRIV_NONE);
}

async function deleteOne(row: ParsedRow, options: Required<Pick<BatchOptions, 'cleanEffect' | 'domainId' | 'dryrun' | 'hardDelete'>>) {
    const udoc = await resolveUser(options.domainId, row.data);
    if (!udoc) throw new Error('User not found.');
    assertEditableUser(udoc);

    if (options.dryrun) {
        return {
            uid: udoc._id,
            mail: udoc.mail,
            uname: udoc.uname,
            message: options.hardDelete ? 'Will hard delete user.' : 'Will disable user.',
        };
    }

    if (options.cleanEffect || options.hardDelete) await cleanUserEffect(udoc._id, options.hardDelete);
    else await UserModel.setPriv(udoc._id, PRIV.PRIV_NONE);
    (UserModel as any)._deleteUserCache?.(udoc);
    return {
        uid: udoc._id,
        mail: udoc.mail,
        uname: udoc.uname,
        message: options.hardDelete ? 'Hard deleted user.' : 'Disabled user.',
    };
}

export async function runBatch(action: Action, raw: string, options: BatchOptions = {}) {
    const dryrun = options.dryrun ?? true;
    const domainId = options.domainId || DEFAULT_DOMAIN;
    const ip = options.ip || '127.0.0.1';
    const cleanEffect = options.cleanEffect ?? true;
    const hardDelete = options.hardDelete ?? false;
    const headers = action === 'add' ? DEFAULT_CREATE_HEADERS : action === 'update' ? DEFAULT_UPDATE_HEADERS : DEFAULT_DELETE_HEADERS;
    const rows = parseRows(raw, headers);
    const result = createResult(action, dryrun, rows.length);

    const seenMail = new Set<string>();
    const seenName = new Set<string>();
    const seenUid = new Set<number>();

    for (const row of rows) {
        try {
            if (action === 'add') {
                const mail = row.data.mail?.toString().toLowerCase();
                const uname = row.data.uname?.toString().toLowerCase();
                const uid = parseUid(row.data.uid);
                if (mail && seenMail.has(mail)) throw new Error(`Duplicate email in input: ${row.data.mail}`);
                if (uname && seenName.has(uname)) throw new Error(`Duplicate username in input: ${row.data.uname}`);
                if (uid !== undefined && seenUid.has(uid)) throw new Error(`Duplicate uid in input: ${uid}`);
                if (mail) seenMail.add(mail);
                if (uname) seenName.add(uname);
                if (uid !== undefined) seenUid.add(uid);
                const data = await addOne(row, { domainId, dryrun, ip });
                pushRow(result, { line: row.line, status: dryrun ? 'dryrun' : 'ok', ...data }, options.report);
            } else if (action === 'update') {
                const data = await updateOne(row, { domainId, dryrun });
                pushRow(result, {
                    line: row.line,
                    status: data.skipped ? 'skipped' : dryrun ? 'dryrun' : 'ok',
                    ...data,
                }, options.report);
            } else {
                const data = await deleteOne(row, { cleanEffect, domainId, dryrun, hardDelete });
                pushRow(result, { line: row.line, status: dryrun ? 'dryrun' : 'ok', ...data }, options.report);
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            pushRow(result, {
                line: row.line,
                message,
                status: 'error',
            }, options.report);
        }
    }

    result.messages.push(`Total ${result.total}, updated ${result.updated}, skipped ${result.skipped}, errors ${result.errors}.`);
    return result;
}

function pageBody(extra: Record<string, any> = {}) {
    return {
        action: 'add',
        cleanEffect: true,
        data: '',
        dryrun: true,
        hardDelete: false,
        query: { q: '', searchBy: 'auto' },
        users: [],
        userTotal: 0,
        ...extra,
    };
}

function getQuery(requestQuery: any) {
    const q = typeof requestQuery.q === 'string' ? requestQuery.q.trim() : '';
    return {
        q,
        searchBy: normalizeSearchBy(requestQuery.searchBy),
    };
}

function getBodyQuery(body: any) {
    return {
        q: bodyValue(body || {}, 'q'),
        searchBy: normalizeSearchBy(body?.searchBy),
    };
}

class UserManagementHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        const query = getQuery(this.request.query);
        const userResult = await queryUsers(this.args.domainId || DEFAULT_DOMAIN, query.q, query.searchBy, DEFAULT_QUERY_LIMIT);
        this.response.template = 'manage_user_management.html';
        this.response.body = pageBody({
            query,
            users: userResult.rows,
            userLimited: userResult.limited,
            userTotal: userResult.total,
        });
    }

    @requireSudo
    async post(args: any) {
        const domainId = args.domainId || DEFAULT_DOMAIN;
        const body = this.request.body || {};
        if (body.operation) return;

        const action = convertByType(StringType, body.action, 'action');
        const data = convertByType(ContentType, body.data, 'data');
        const dryrun = parseBool(body.dryrun) ?? true;
        const hardDelete = parseBool(body.hardDelete) ?? false;
        const cleanEffect = parseBool(body.cleanEffect) ?? true;
        const normalized = normalizeAction(action);
        const result = await runBatch(normalized, data, {
            cleanEffect,
            domainId,
            dryrun,
            hardDelete,
            ip: this.request.ip,
        });
        const query = { q: '', searchBy: 'auto' as SearchBy };
        const userResult = await queryUsers(domainId, query.q, query.searchBy, DEFAULT_QUERY_LIMIT);
        this.response.template = 'manage_user_management.html';
        this.response.body = pageBody({
            action: normalized,
            cleanEffect,
            data,
            dryrun,
            hardDelete,
            query,
            result,
            users: userResult.rows,
            userLimited: userResult.limited,
            userTotal: userResult.total,
        });
    }

    @requireSudo
    async postUpdateUser(args: any) {
        const domainId = args.domainId || DEFAULT_DOMAIN;
        const body = this.request.body || {};
        await updateQueriedUser(domainId, body);
        const query = getBodyQuery(body);
        this.response.redirect = this.url('manage_user_management', { query });
    }

    @requireSudo
    async postDeleteUser(args: any) {
        const domainId = args.domainId || DEFAULT_DOMAIN;
        const body = this.request.body || {};
        const uid = parseUid(body.uid);
        if (uid === undefined) throw new Error('Missing uid.');
        await deleteOne({ line: 1, data: { uid } }, {
            cleanEffect: true,
            domainId,
            dryrun: false,
            hardDelete: false,
        });
        const query = getBodyQuery(body);
        this.response.redirect = this.url('manage_user_management', { query });
    }
}

class UserManagementExportHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        const query = getQuery(this.request.query);
        const userResult = await queryUsers(this.args.domainId || DEFAULT_DOMAIN, query.q, query.searchBy);
        const suffix = query.q ? `${query.searchBy}-${query.q}` : 'all';
        this.binary(Buffer.from(usersToCsv(userResult.rows)), `hydro-users-${suffix}-${Date.now()}.csv`);
        this.response.type = 'text/csv; charset=utf-8';
    }
}

const scriptSchema = Schema.object({
    domainId: Schema.string().default(DEFAULT_DOMAIN).description('Domain ID'),
    data: Schema.string().role('textarea').required().description('Batch data'),
    dryrun: Schema.boolean().default(true).description('Preview only'),
});

export async function apply(ctx: Context) {
    ctx.Route('manage_user_management', '/manage/user-management', UserManagementHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('manage_user_management_export', '/manage/user-management/export', UserManagementExportHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.injectUI('ControlPanel', 'manage_user_management');

    ctx.addScript('batchAddUser', 'Batch add users', scriptSchema, async (args, report) => {
        await runBatch('add', args.data, {
            domainId: args.domainId,
            dryrun: args.dryrun,
            report,
        });
        return true;
    });
    ctx.addScript('batchUpdateUser', 'Batch update users', scriptSchema, async (args, report) => {
        await runBatch('update', args.data, {
            domainId: args.domainId,
            dryrun: args.dryrun,
            report,
        });
        return true;
    });
    ctx.addScript('batchDeleteUser', 'Batch disable/delete users', Schema.intersect([
        scriptSchema,
        Schema.object({
            cleanEffect: Schema.boolean().default(true).description('Clean user effects'),
            hardDelete: Schema.boolean().default(false).description('Hard delete user documents'),
        }),
    ]), async (args, report) => {
        await runBatch('delete', args.data, {
            cleanEffect: args.cleanEffect,
            domainId: args.domainId,
            dryrun: args.dryrun,
            hardDelete: args.hardDelete,
            report,
        });
        return true;
    });

    ctx.i18n.load('zh', {
        'Batch User Management': '批量用户管理',
        'Batch add users': '批量添加用户',
        'Batch disable/delete users': '批量禁用/删除用户',
        'Batch update users': '批量修改用户',
        Action: '操作',
        Actions: '操作',
        Cancel: '取消',
        'Clean related data': '清理关联数据',
        'Confirm delete user?': '确认删除该用户？',
        Delete: '删除',
        'Delete User': '删除用户',
        'Display Name': '显示名',
        Edit: '修改',
        'Edit User': '修改用户',
        Email: '电子邮件',
        'Export CSV': '导出 CSV',
        'Export current query': '导出当前查询',
        Groups: '用户组',
        'Hard delete user document': '物理删除用户文档',
        'Leave blank to keep current password.': '留空表示不修改密码。',
        Line: '行号',
        Message: '消息',
        'No results': '无结果',
        Password: '密码',
        'Preview only': '仅预览',
        Privilege: '权限',
        'Protected user cannot be edited or deleted.': '受保护用户不能修改或删除。',
        'Query Users': '查询用户',
        Role: '角色',
        'Run': '执行',
        Save: '保存',
        School: '学校',
        'Search': '查询',
        'Search By': '查询字段',
        'Search keyword': '查询关键词',
        'Showing first {0} users of {1}. Export CSV to get all matched users.': '当前显示前 {0} 个用户，共 {1} 个。导出 CSV 可获取全部匹配用户。',
        Status: '状态',
        'Student ID': '学号',
        'This will clean related data and disable the user.': '将清理关联数据并禁用该用户。',
        'User Export': '用户导出',
        'User ID': 'UID',
        Username: '用户名',
        Users: '用户',
        auto: '自动',
        mail: '邮箱',
        uid: 'UID',
        manage_user_management: '批量用户管理',
        uname: '用户名',
    });
    ctx.i18n.load('en', {
        manage_user_management: 'Batch User Management',
    });
}

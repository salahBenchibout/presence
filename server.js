process.env.TZ ||= 'Africa/Algiers';
const express = require('express'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), cookie = require('cookie-parser'), crypto = require('crypto'),
  QR = require('qrcode'), rate = require('express-rate-limit'), helmet = require('helmet');

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB || 'presence.db');
db.exec('PRAGMA journal_mode=WAL');
const tx = f => { db.exec('BEGIN'); try { f(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE,password_hash TEXT,role TEXT,active INTEGER DEFAULT 1,must_change INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS classes(id INTEGER PRIMARY KEY,name TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY,name TEXT,class_id INTEGER REFERENCES classes(id));
CREATE TABLE IF NOT EXISTS checkins(id INTEGER PRIMARY KEY,teacher_id INTEGER,date TEXT,checked_at TEXT,status TEXT,ip TEXT,UNIQUE(teacher_id,date));
CREATE TABLE IF NOT EXISTS attendance(class_id INTEGER,date TEXT,student_id INTEGER,status TEXT,teacher_id INTEGER,PRIMARY KEY(class_id,date,student_id));
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);`);

db.exec(`CREATE TABLE IF NOT EXISTS modules(id INTEGER PRIMARY KEY,teacher_id INTEGER,class_id INTEGER,name TEXT,semester INTEGER,UNIQUE(teacher_id,class_id,name,semester));`);
try { db.exec('ALTER TABLE users ADD COLUMN matricule TEXT'); } catch {}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_mat ON users(matricule)');
for (const c of ['matricule', 'niveau', 'domaine', 'filiere', 'specialite', 'gkey', 'sit']) { try { db.exec(`ALTER TABLE students ADD COLUMN ${c} TEXT`); } catch {} }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_smat ON students(matricule)');
// Official list of modules per class (filière & année), per academic year; teacher assignments in `modules` link to it through catalog_id
db.exec('CREATE TABLE IF NOT EXISTS catalog(id INTEGER PRIMARY KEY,code TEXT,name TEXT,name_ar TEXT,class_id INTEGER,semester INTEGER,nature TEXT,cycle TEXT,year TEXT,nkey TEXT,UNIQUE(class_id,semester,year,nkey))');
try { db.exec('ALTER TABLE modules ADD COLUMN catalog_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE student_groups ADD COLUMN manual INTEGER DEFAULT 0'); } catch {}   // 1 = the admin chose the class by hand
db.exec('CREATE TABLE IF NOT EXISTS student_groups(gkey TEXT PRIMARY KEY,niveau TEXT,domaine TEXT,filiere TEXT,specialite TEXT,class_id INTEGER)');
if (!db.prepare('PRAGMA table_info(attendance)').all().some(c => c.name === 'module_id'))
  db.exec(`ALTER TABLE attendance RENAME TO attendance_old;
  CREATE TABLE attendance(class_id INTEGER,module_id INTEGER DEFAULT 0,date TEXT,student_id INTEGER,status TEXT,teacher_id INTEGER,PRIMARY KEY(class_id,module_id,date,student_id));
  INSERT INTO attendance(class_id,module_id,date,student_id,status,teacher_id) SELECT class_id,0,date,student_id,status,teacher_id FROM attendance_old;
  DROP TABLE attendance_old;`);
try { db.exec('ALTER TABLE attendance ADD COLUMN arrived_at TEXT'); } catch {}

const get = k => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v;
const set = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
if (!get('jwt')) set('jwt', crypto.randomBytes(32).toString('hex'));
if (!get('qr_secret')) set('qr_secret', crypto.randomBytes(32).toString('hex'));
if (!get('late_time')) set('late_time', '08:30');
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get())
  db.prepare('INSERT INTO users(name,email,password_hash,role,must_change) VALUES(?,?,?,?,1)')
    .run('Admin', 'admin@school.dz', bcrypt.hashSync('admin123', 10), 'admin');

if (process.argv.includes('--seed')) {
  const ins = db.prepare('INSERT OR IGNORE INTO classes(name) VALUES(?)');
  ['Class A', 'Class B'].forEach(n => ins.run(n));
  db.prepare('INSERT OR IGNORE INTO users(name,email,password_hash,role,must_change) VALUES(?,?,?,?,1)')
    .run('Demo Teacher', 'teacher@school.dz', bcrypt.hashSync('teacher123', 10), 'teacher');
  if (!db.prepare('SELECT 1 FROM students').get())
    for (let i = 1; i <= 12; i++) db.prepare('INSERT INTO students(name,class_id) VALUES(?,?)').run('Student ' + i, i % 2 + 1);
  console.log('Seeded demo data.');
}

// Create teacher accounts (login = matricule, random temporary password) and their modules; existing teachers and modules are left untouched.
function importTeachers(data) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789', pw = () => Array.from(crypto.randomBytes(8), b => chars[b % chars.length]).join('');
  const out = { added: 0, existing: 0, modules: 0, credentials: [] };
  tx(() => {
    for (const t of data) {
      const mat = String(t.matricule || '').trim(), name = String(t.name || '').trim(); if (!mat || !name) continue;
      let u = db.prepare('SELECT id FROM users WHERE matricule=?').get(mat);
      if (!u) {
        const p = pw();
        u = { id: Number(db.prepare("INSERT INTO users(name,email,password_hash,role,must_change,matricule) VALUES(?,NULL,?,'teacher',1,?)").run(name, bcrypt.hashSync(p, 10), mat).lastInsertRowid) };
        out.added++; out.credentials.push({ matricule: mat, name, password: p });
      } else out.existing++;
      for (const m of t.modules || []) {
        const cls = String(m.class || '').replace(/\s+/g, ' ').trim(), mn = String(m.name || '').replace(/\s+/g, ' ').trim(), sem = +m.semester;
        if (!cls || !mn || !(sem >= 1 && sem <= 12)) continue;
        db.prepare('INSERT OR IGNORE INTO classes(name) VALUES(?)').run(cls);
        const cid = db.prepare('SELECT id FROM classes WHERE name=?').get(cls).id;
        out.modules += Number(db.prepare('INSERT OR IGNORE INTO modules(teacher_id,class_id,name,semester) VALUES(?,?,?,?)').run(u.id, cid, mn, sem).changes);
      }
    }
  });
  return out;
}
const imp = process.argv.indexOf('--import');
if (imp > -1) {
  const fs = require('fs'), r = importTeachers(JSON.parse(fs.readFileSync(process.argv[imp + 1] || 'teachers.json', 'utf8')));
  if (r.added) fs.writeFileSync('credentials.csv', '\ufeff' + ['matricule,name,temporary_password', ...r.credentials.map(c => [c.matricule, c.name, c.password].map(v => '"' + v.replace(/"/g, '""') + '"').join(','))].join('\n'));
  console.log(`Imported ${r.added} new teachers and ${r.modules} modules.` + (r.added ? ' Temporary passwords are in credentials.csv.' : ''));
  process.exit(0);
}

const today = () => new Date().toLocaleDateString('en-CA');
const hm = () => new Date().toTimeString().slice(0, 5);
const sig = d => crypto.createHmac('sha256', get('qr_secret')).update(d).digest('hex');
const bad = (res, m, c = 400) => res.status(c).json({ error: m });
const STATUS = ['present', 'late', 'absent'];
const TSTATUS = ['present', 'absent'];   // what teachers can record for a student

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use('/api/students/import', express.json({ limit: '15mb' }));   // student files can be large
app.use('/api/catalog/import', express.json({ limit: '15mb' }));
app.use('/api/teachers/import', express.json({ limit: '15mb' }));
app.use(express.json({ limit: '200kb' }), cookie());
// keep the current academic year's teacher/module program saved whenever modules or teachers change
app.use('/api', (req, res, next) => { if (req.method !== 'GET') res.on('finish', () => { if (/^\/api\/(modules|teachers)/.test(req.originalUrl)) { try { linkModules(); } catch {} refreshSnapshot(); } }); next(); });
app.use(express.static('public'));

const auth = role => (req, res, next) => {
  try {
    const t = jwt.verify(req.cookies.t || '', get('jwt'));
    const u = db.prepare('SELECT id,name,email,role,active,must_change FROM users WHERE id=?').get(t.id);
    if (!u || !u.active) throw 0;
    if (role && u.role !== role) return bad(res, 'Forbidden', 403);
    req.user = u; next();
  } catch { bad(res, 'Login required', 401); }
};
const admin = auth('admin'), teacher = auth('teacher'), anyone = auth();

// ---- auth
const fails = {};
app.post('/api/login', rate({ windowMs: 15 * 60e3, limit: 30 }), (req, res) => {
  const email = String(req.body.email || '').toLowerCase(), f = fails[email];
  if (f && f.n >= 5 && Date.now() - f.t < 9e5) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
  const u = db.prepare('SELECT * FROM users WHERE lower(email)=? OR lower(matricule)=?').get(email, email);
  if (!u || !u.active || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    fails[email] = { n: (f && Date.now() - f.t < 9e5 ? f.n : 0) + 1, t: Date.now() };
    return bad(res, 'Wrong email or password', 401);
  }
  delete fails[email];
  res.cookie('t', jwt.sign({ id: u.id }, get('jwt'), { expiresIn: '12h' }),
    { httpOnly: true, sameSite: 'strict', secure: !!process.env.COOKIE_SECURE, maxAge: 12 * 3600e3 });
  res.json({ id: u.id, name: u.name, role: u.role, must_change: u.must_change });
});
app.post('/api/logout', (req, res) => res.clearCookie('t').json({ ok: 1 }));
app.get('/api/me', anyone, (req, res) => res.json(req.user));
app.post('/api/password', anyone, (req, res) => {
  const p = String(req.body.password || '');
  if (p.length < 8) return bad(res, 'Password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash=?,must_change=0 WHERE id=?').run(bcrypt.hashSync(p, 10), req.user.id);
  res.json({ ok: 1 });
});

// ---- admin: teachers
app.get('/api/teachers', admin, (req, res) =>
  res.json(db.prepare(`SELECT u.id,u.name,u.email,u.matricule,u.active,(SELECT COUNT(*) FROM modules m WHERE m.teacher_id=u.id) AS modules
    FROM users u WHERE u.role='teacher' ORDER BY u.name`).all()));
app.get('/api/teachers/:id/modules', admin, (req, res) => res.json(db.prepare(
  'SELECT m.name,m.semester,c.name AS class FROM modules m JOIN classes c ON c.id=m.class_id WHERE m.teacher_id=? ORDER BY m.name').all(+req.params.id)));
app.get('/api/my-modules', teacher, (req, res) => res.json(db.prepare(
  'SELECT m.id,m.name,m.semester,c.name AS class FROM modules m JOIN classes c ON c.id=m.class_id WHERE m.teacher_id=? ORDER BY m.name').all(req.user.id)));
app.post('/api/teachers', admin, (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || String(password || '').length < 8) return bad(res, 'Name, email and a password of 8+ characters are required');
  try {
    db.prepare("INSERT INTO users(name,email,password_hash,role,must_change) VALUES(?,?,?, 'teacher',1)")
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10));
    res.json({ ok: 1 });
  } catch { bad(res, 'That email is already in use'); }
});
app.patch('/api/teachers/:id', admin, (req, res) => {
  const id = +req.params.id;
  if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='teacher'").get(id)) return bad(res, 'Not found', 404);
  if (req.body.active !== undefined) db.prepare('UPDATE users SET active=? WHERE id=?').run(req.body.active ? 1 : 0, id);
  try {
    if (req.body.name !== undefined) {
      const n = String(req.body.name).trim(); if (!n) return bad(res, 'Name cannot be empty');
      db.prepare('UPDATE users SET name=? WHERE id=?').run(n, id);
    }
    if (req.body.matricule !== undefined) {
      const v = String(req.body.matricule).trim(); if (!v) return bad(res, 'Matricule cannot be empty');
      db.prepare('UPDATE users SET matricule=? WHERE id=?').run(v, id);
    }
    if (req.body.email !== undefined) {
      const v = String(req.body.email).trim().toLowerCase(); if (!v) return bad(res, 'Email cannot be empty');
      db.prepare('UPDATE users SET email=? WHERE id=?').run(v, id);
    }
  } catch { return bad(res, 'That matricule or email is already in use'); }
  if (req.body.password !== undefined) {
    if (String(req.body.password).length < 8) return bad(res, 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash=?,must_change=1 WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), id);
  }
  res.json({ ok: 1 });
});

// ---- admin: modules (who teaches what, reassignment when a teacher leaves)
app.post('/api/teachers/import', admin, (req, res) => {
  const data = req.body.teachers; if (!Array.isArray(data) || !data.length) return bad(res, 'Nothing to import');
  try { res.json({ ok: 1, ...importTeachers(data) }); } catch (e) { bad(res, 'Import failed: ' + e.message); }
});
app.get('/api/modules', admin, (req, res) => res.json(db.prepare(`SELECT m.id,m.name,m.semester,m.class_id,c.name AS class,
  m.teacher_id,u.name AS teacher,u.matricule,u.email,COALESCE(u.active,0) AS active,
  (SELECT COUNT(*) FROM modules x WHERE x.teacher_id=m.teacher_id) AS teacher_modules,
  m.catalog_id,COALESCE(k.code,'') AS code,(SELECT COUNT(*) FROM students s WHERE s.class_id=m.class_id) AS students
  FROM modules m JOIN classes c ON c.id=m.class_id LEFT JOIN users u ON u.id=m.teacher_id LEFT JOIN catalog k ON k.id=m.catalog_id ORDER BY m.name,c.name,m.semester`).all()));
app.post('/api/modules', admin, (req, res) => {
  let tid = +req.body.teacher_id, cid = +req.body.class_id, name = String(req.body.name || '').trim(), sem = +req.body.semester || 1, kid = null;
  if (req.body.catalog_id) {   // a module of the official list: class, name and semester come from it
    const k = db.prepare('SELECT * FROM catalog WHERE id=?').get(+req.body.catalog_id); if (!k) return bad(res, 'Module not found');
    kid = k.id; cid = k.class_id; name = k.name || k.name_ar; sem = k.semester;
  }
  if (!name || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='teacher'").get(tid) || !db.prepare('SELECT 1 FROM classes WHERE id=?').get(cid))
    return bad(res, 'Teacher, class and module name are required');
  try { db.prepare('INSERT INTO modules(teacher_id,class_id,name,semester,catalog_id) VALUES(?,?,?,?,?)').run(tid, cid, name, sem, kid); res.json({ ok: 1 }); }
  catch { bad(res, 'That teacher already has this module for this class'); }
});
app.delete('/api/modules/:id', admin, (req, res) => {
  db.prepare('DELETE FROM modules WHERE id=?').run(+req.params.id); res.json({ ok: 1 });
});
// Change the teacher of a module: pick an existing teacher or create a new account on the spot.
// body: { teacher_id | new_teacher:{name,matricule,email}, all?:bool (every module of the old teacher), disable_old?:bool }
app.patch('/api/modules/:id', admin, (req, res) => {
  const m = db.prepare('SELECT * FROM modules WHERE id=?').get(+req.params.id);
  if (!m) return bad(res, 'Not found', 404);
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let tid = +req.body.teacher_id, temp = null, moved = 0, skipped = 0, login = null;
  try {
    tx(() => {
      const n = req.body.new_teacher;
      if (n) {
        const name = String(n.name || '').trim(), mat = String(n.matricule || '').trim() || null, email = String(n.email || '').trim().toLowerCase() || null;
        if (!name || (!mat && !email)) throw new Error('A new teacher needs a name and a matricule or email');
        temp = Array.from(crypto.randomBytes(8), b => chars[b % chars.length]).join('');
        tid = Number(db.prepare("INSERT INTO users(name,email,password_hash,role,must_change,matricule) VALUES(?,?,?,'teacher',1,?)")
          .run(name, email, bcrypt.hashSync(temp, 10), mat).lastInsertRowid);
        login = mat || email;
      } else if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='teacher' AND active=1").get(tid)) throw new Error('Choose an active teacher');
      if (tid === m.teacher_id) throw new Error('That teacher already has this module');
      const ids = req.body.all ? db.prepare('SELECT id FROM modules WHERE teacher_id=?').all(m.teacher_id).map(r => r.id) : [m.id];
      for (const id of ids) {
        const c = db.prepare('UPDATE OR IGNORE modules SET teacher_id=? WHERE id=?').run(tid, id).changes;
        c ? moved++ : skipped++;   // skipped: new teacher already has the same module/class/semester
      }
      if (!moved) throw new Error('That teacher already has this module for this class');
      if (req.body.disable_old && !db.prepare('SELECT 1 FROM modules WHERE teacher_id=?').get(m.teacher_id))
        db.prepare('UPDATE users SET active=0 WHERE id=?').run(m.teacher_id);
    });
  } catch (e) { return bad(res, /UNIQUE/.test(e.message) ? 'That matricule or email is already in use' : e.message); }
  res.json({ ok: 1, moved, skipped, teacher_id: tid, login, temp_password: temp });
});

// ---- classes & students
app.get('/api/classes', anyone, (req, res) => res.json(db.prepare('SELECT c.*,((SELECT COUNT(*) FROM catalog k WHERE k.class_id=c.id)+(SELECT COUNT(*) FROM modules m WHERE m.class_id=c.id AND m.catalog_id IS NULL)) AS modules FROM classes c ORDER BY c.name').all()));
app.post('/api/classes', admin, (req, res) => {
  try { db.prepare('INSERT INTO classes(name) VALUES(?)').run(String(req.body.name || '').trim()); res.json({ ok: 1 }); }
  catch { bad(res, 'Class name is empty or already exists'); }
});
app.get('/api/students', admin, (req, res) => res.json(db.prepare(
  'SELECT s.id,s.name,s.matricule,s.specialite,s.sit,c.name AS class FROM students s JOIN classes c ON c.id=s.class_id ORDER BY c.name,s.name').all()));
app.post('/api/students', admin, (req, res) => {
  const name = String(req.body.name || '').trim(), cid = +req.body.class_id;
  if (!name || !db.prepare('SELECT 1 FROM classes WHERE id=?').get(cid)) return bad(res, 'Name and class are required');
  db.prepare('INSERT INTO students(name,class_id) VALUES(?,?)').run(name, cid); res.json({ ok: 1 });
});
// Student import. Expected columns (header row, tab/;/, separated, as pasted from Excel):
// Mat. Etudiant | Nom | Prénom | Libellé domaine | Libellé filière | specialité | Code niveau
// Each (niveau, filière, spécialité) group is linked to one class; teachers only ever see the students of the class their module belongs to.
const norm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
const YEARS = ['', 'Première', 'Deuxième', 'Troisième'];
const levelInfo = n => { const t = String(n || '').trim(), y = /[123]/.exec(t); return { year: y ? +y[0] : 0, dg: /^\s*l|licen/i.test(t) ? 'licence' : /^\s*m|master/i.test(t) ? 'master' : '' }; };
const parseClass = n => {
  const m = /^(Première|Deuxième|Troisième) année \((.*)\)$/.exec(n); if (!m) return null;
  const d = /\s(Licence|Master)$/.exec(m[2]);
  return { year: YEARS.indexOf(m[1]), dg: d ? d[1].toLowerCase() : '', base: norm(d ? m[2].slice(0, d.index) : m[2]) };
};
// Filière labels in the student file often differ from the class names of the teacher list; these rules bridge the known cases.
const ALIASES = [
  [/langue anglaise|langues? etrangeres?|litterature|anglais/, 'litterature et langues etrangeres'],
  [/sciences economiques|commerciales|segsc|sciences financieres|comptabilite/, 'segsc'],
  [/sciences humaines/, 'sciences humaines'],
  [/didactique/, 'didactics'],
  [/anglais technique pour le manag/, 'management in english'],
  [/relations? publiques?/, 'relation publique'],
  [/transparence|corruption/, 'lutte anti corruption'],
  [/droit du travail|securite social/, 'droit du travail'],
  [/penal|criminelles/, 'droit penal'],
  [/presse/, 'presse'],
];
const SPE_ALIASES = [[/لغةانجليزية طبية|medical/, 'english for medical']];   // matched on the spécialité only
const classModCount = id => db.prepare('SELECT (SELECT COUNT(*) FROM catalog WHERE class_id=?)+(SELECT COUNT(*) FROM modules WHERE class_id=? AND catalog_id IS NULL) AS n').get(id, id).n;
function findClass(niv, fil, spe) {
  const { year, dg } = levelInfo(niv), clean = c => norm(c).replace(/\b(licence|master)\b/g, '').trim();
  const sp = clean(spe), fi = clean(fil), cands = [sp, fi].filter(c => c.length >= 3);
  let best = [], bs = 0;
  for (const c of db.prepare('SELECT id,name FROM classes').all().filter(c => classModCount(c.id) > 0)) {   // empty classes made by an earlier import never attract students
    const p = parseClass(c.name); if (!p || (year && p.year !== year) || (dg && p.dg && p.dg !== dg)) continue;
    let sc = 0;
    // a spécialité match counts far more than a filière match, otherwise every class of a filière would tie
    const test = (x, exact, part) => { if (x.length < 3) return; if (p.base === x) sc = Math.max(sc, exact); else if (p.base.includes(x) || x.includes(p.base)) sc = Math.max(sc, part); };
    test(sp, 5, 4); test(fi, 3, 1);
    for (const [re, al] of ALIASES) if (cands.some(x => re.test(x)) && p.base.includes(al)) sc = Math.max(sc, 2);
    for (const [re, al] of SPE_ALIASES) if (re.test(sp) && p.base.includes(al)) sc = Math.max(sc, 4);
    if (sc > bs) { bs = sc; best = [c]; } else if (sc && sc === bs) best.push(c);
  }
  return best.length === 1 ? best[0].id : null;
}
app.post('/api/students/import', admin, (req, res) => {
  const lines = String(req.body.csv || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return bad(res, 'Nothing to import');
  const delim = l => l.includes('\t') ? '\t' : l.includes(';') ? ';' : ',';
  const head = lines[0].split(delim(lines[0])).map(norm), at = f => head.findIndex(f);
  // Real exports have many look-alike columns (Mat. BAC / Mat. Etudiant, Code filière / Libellé filière, Situation familiale / Sit. d'ins.),
  // so exact names are tried first and looser matches only as a fallback.
  const pick = (...ps) => { for (const p of ps) { const i = head.findIndex(p); if (i >= 0) return i; } return -1; };
  const ix = {
    mat: pick(h => /^mat(ricule)?( etud\w*)?$/.test(h), h => h.startsWith('mat') && h.includes('etud'), h => h.startsWith('mat') && !h.includes('bac')),
    nom: pick(h => h === 'nom'),
    pre: pick(h => h === 'prenom', h => h.startsWith('prenom') && !/(mere|pere)/.test(h)),
    dom: pick(h => h === 'libelle domaine', h => h.includes('domaine') && !h.startsWith('code')),
    fil: pick(h => h === 'libelle filiere', h => h.includes('filiere') && !h.startsWith('code') && !h.includes('circulaire') && !h.includes('ciculaire')),
    spe: pick(h => h.includes('specialite')),
    sit: pick(h => h.startsWith('sit d ins'), h => h.startsWith('sit d')),
    niv: pick(h => h === 'code niveau', h => h === 'niveau', h => h.includes('niveau') && !h.startsWith('libelle')),
  };
  if (ix.mat < 0 || ix.nom < 0) {   // old format: "name, class" per line
    let n = 0;
    tx(() => lines.forEach(line => {
      const i = line.lastIndexOf(','); if (i < 1) return;
      const name = line.slice(0, i).trim(), cls = line.slice(i + 1).trim(); if (!name || !cls) return;
      db.prepare('INSERT OR IGNORE INTO classes(name) VALUES(?)').run(cls);
      db.prepare('INSERT INTO students(name,class_id) VALUES(?,(SELECT id FROM classes WHERE name=?))').run(name, cls); n++;
    }));
    return res.json({ imported: n, added: n, updated: 0, skipped: 0, new_classes: [] });
  }
  const d = delim(lines[0]), out = { added: 0, updated: 0, skipped: 0, new_classes: [] }, cache = new Map();
  const resolve = (niv, dom, fil, spe) => {
    const key = [niv, fil, spe].map(norm).join('|'); if (cache.has(key)) return { key, cid: cache.get(key) };
    let cid = db.prepare('SELECT class_id FROM student_groups WHERE gkey=?').get(key)?.class_id;
    if (!cid) {
      cid = findClass(niv, fil, spe);
      if (!cid) {
        const { year, dg } = levelInfo(niv), name = `${year ? YEARS[year] + ' année' : niv || 'Niveau ?'} (${spe || fil || 'Sans filière'}${dg ? ' ' + dg[0].toUpperCase() + dg.slice(1) : ''})`;
        db.prepare('INSERT OR IGNORE INTO classes(name) VALUES(?)').run(name);
        cid = db.prepare('SELECT id FROM classes WHERE name=?').get(name).id; out.new_classes.push(name);
      }
      db.prepare('INSERT INTO student_groups(gkey,niveau,domaine,filiere,specialite,class_id) VALUES(?,?,?,?,?,?)').run(key, niv, dom, fil, spe, cid);
    }
    cache.set(key, cid); return { key, cid };
  };
  try {
    tx(() => lines.slice(1).forEach(line => {
      const c = line.split(d).map(x => x.trim()), g = i => i < 0 ? '' : (c[i] || '');
      const mat = g(ix.mat), name = (g(ix.nom) + ' ' + g(ix.pre)).trim();
      if (!mat || !name) { out.skipped++; return; }
      const niv = g(ix.niv), dom = g(ix.dom), fil = g(ix.fil), spe = g(ix.spe), sit = g(ix.sit), { key, cid } = resolve(niv, dom, fil, spe);
      const ex = db.prepare('SELECT id FROM students WHERE matricule=?').get(mat);
      if (ex) { db.prepare('UPDATE students SET name=?,class_id=?,niveau=?,domaine=?,filiere=?,specialite=?,gkey=?,sit=? WHERE id=?').run(name, cid, niv, dom, fil, spe, key, sit, ex.id); out.updated++; }
      else { db.prepare('INSERT INTO students(name,class_id,matricule,niveau,domaine,filiere,specialite,gkey,sit) VALUES(?,?,?,?,?,?,?,?,?)').run(name, cid, mat, niv, dom, fil, spe, key, sit); out.added++; }
    }));
  } catch (e) { return bad(res, 'Import failed: ' + e.message); }
  res.json({ imported: out.added + out.updated, ...out });
});
// Student groups: which class each (level, filière, spécialité) group of students belongs to; the admin can correct it.
// ---- official module list (catalog) and the program of each class
const arNorm = x => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
  .toLowerCase().replace(/[^a-z0-9\u0621-\u064a]+/g, ' ').trim();
function linkModules() {   // connect teacher assignments to the official list (same class, semester and name)
  const map = new Map();
  db.prepare('SELECT id,class_id,semester,nkey FROM catalog ORDER BY year DESC').all().forEach(k => { const key = `${k.class_id}|${k.semester}|${k.nkey}`; if (!map.has(key)) map.set(key, k.id); });
  let n = 0;
  tx(() => db.prepare('SELECT id,class_id,semester,name FROM modules WHERE catalog_id IS NULL').all().forEach(m => {
    const id = map.get(`${m.class_id}|${m.semester}|${arNorm(m.name)}`);
    if (id) { db.prepare('UPDATE modules SET catalog_id=? WHERE id=?').run(id, m.id); n++; }
  }));
  return n;
}
function importCatalog(rows) {
  const r = { added: 0, updated: 0, skipped: 0, new_classes: [] };
  tx(() => rows.forEach(x => {
    const name = String(x.name || '').replace(/\s+/g, ' ').trim(), ar = String(x.name_ar || '').replace(/\s+/g, ' ').trim(), cls = String(x.class || '').replace(/\s+/g, ' ').trim(), sem = +x.semester, key = arNorm(name || ar);
    if (!key || !cls || !(sem >= 1 && sem <= 12)) { r.skipped++; return; }
    const y = String(x.year || '').trim(), year = /^\d{4}$/.test(y) ? `${y}/${+y + 1}` : validAY(y) ? y : curAY();
    let c = db.prepare('SELECT id FROM classes WHERE name=?').get(cls);
    if (!c) { db.prepare('INSERT INTO classes(name) VALUES(?)').run(cls); c = db.prepare('SELECT id FROM classes WHERE name=?').get(cls); r.new_classes.push(cls); }
    const ex = db.prepare('SELECT id FROM catalog WHERE class_id=? AND semester=? AND year=? AND nkey=?').get(c.id, sem, year, key);
    if (ex) { db.prepare('UPDATE catalog SET code=?,name=?,name_ar=?,nature=?,cycle=? WHERE id=?').run(String(x.code || ''), name, ar, String(x.nature || ''), String(x.cycle || ''), ex.id); r.updated++; }
    else { db.prepare('INSERT INTO catalog(code,name,name_ar,class_id,semester,nature,cycle,year,nkey) VALUES(?,?,?,?,?,?,?,?,?)').run(String(x.code || ''), name, ar, c.id, sem, String(x.nature || ''), String(x.cycle || ''), year, key); r.added++; }
  }));
  r.linked = linkModules();
  Object.assign(r, { groups: rematchGroups() });
  return r;
}
app.post('/api/catalog/import', admin, (req, res) => {
  const rows = req.body.rows; if (!Array.isArray(rows) || !rows.length) return bad(res, 'Nothing to import');
  try { res.json({ ok: 1, ...importCatalog(rows) }); } catch (e) { bad(res, 'Import failed: ' + e.message); }
});
// For every class: its student groups, its modules from the official list and who teaches each one.
function programs() {
  const year = db.prepare('SELECT MAX(year) AS y FROM catalog').get().y || null;
  const cat = year ? db.prepare('SELECT * FROM catalog WHERE year=? ORDER BY semester,COALESCE(NULLIF(name,\'\'),name_ar)').all(year) : [];
  const mods = db.prepare('SELECT m.id,m.catalog_id,m.class_id,m.name,m.semester,m.teacher_id,u.name AS teacher,COALESCE(u.matricule,u.email) AS login,COALESCE(u.active,0) AS active FROM modules m LEFT JOIN users u ON u.id=m.teacher_id').all();
  const stu = Object.fromEntries(db.prepare('SELECT class_id,COUNT(*) AS n FROM students GROUP BY class_id').all().map(r => [r.class_id, r.n]));
  const groups = db.prepare('SELECT g.class_id,g.niveau,g.filiere,g.specialite,(SELECT COUNT(*) FROM students s WHERE s.gkey=g.gkey) AS n FROM student_groups g').all();
  const T = m => ({ module_id: m.id, teacher_id: m.teacher_id, name: m.teacher || '', login: m.login || '', active: !!m.active });
  const classes = db.prepare('SELECT id,name FROM classes ORDER BY name').all().map(c => {
    const own = cat.filter(k => k.class_id === c.id).map(k => ({ catalog_id: k.id, code: k.code, name: k.name || k.name_ar, name_ar: k.name ? k.name_ar : '', semester: k.semester, nature: k.nature, teachers: mods.filter(m => m.catalog_id === k.id).map(T) }));
    const extra = mods.filter(m => m.class_id === c.id && !m.catalog_id).map(m => ({ catalog_id: null, code: '', name: m.name, name_ar: '', semester: m.semester, nature: '', teachers: [T(m)] }));
    return { id: c.id, name: c.name, students: stu[c.id] || 0, groups: groups.filter(g => g.class_id === c.id).map(g => ({ niveau: g.niveau, filiere: g.filiere, specialite: g.specialite, students: g.n })), modules: [...own, ...extra].sort((a, b) => a.semester - b.semester) };
  }).filter(c => c.modules.length || c.students);
  return { year, classes };
}
app.get('/api/programs', admin, (req, res) => res.json(programs()));
app.get('/api/programs.xlsx', admin, async (req, res) => {
  let ExcelJS; try { ExcelJS = require('exceljs'); } catch { return bad(res, 'Excel export needs the exceljs package: run npm install', 500); }
  const P = programs(), wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Program');
  ws.addRow(['Class (filière & année)', 'Students', 'Semester', 'Code', 'Module', 'Module (Arabic)', 'Nature', 'Teacher', 'Teacher login']);
  P.classes.forEach(c => c.modules.forEach(m => { const t = m.teachers.length ? m.teachers : [{ name: '', login: '' }]; t.forEach(x => ws.addRow([c.name, c.students, 'S' + m.semester, m.code, m.name, m.name_ar, m.nature, x.name || '(no teacher yet)', x.login])); }));
  ws.getRow(1).eachCell(c => { c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6F54' } }; });
  [58, 9, 9, 12, 48, 40, 12, 30, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.eachRow((r, n) => { if (n > 1) r.eachCell(c => { c.font = { name: 'Arial', size: 10 }; }); });
  ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.autoFilter = { from: 'A1', to: 'I1' };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="program_${(P.year || 'all').replace('/', '-')}.xlsx"`);
  await wb.xlsx.write(res); res.end();
});
app.get('/api/classes/:id/students', admin, (req, res) => res.json(db.prepare('SELECT id,name,matricule,specialite,sit FROM students WHERE class_id=? ORDER BY name').all(+req.params.id)));
app.get('/api/student-groups', admin, (req, res) => res.json(db.prepare(`SELECT g.gkey,g.niveau,g.domaine,g.filiere,g.specialite,g.class_id,
  (SELECT COUNT(*) FROM students s WHERE s.gkey=g.gkey) AS students,((SELECT COUNT(*) FROM catalog k WHERE k.class_id=g.class_id)+(SELECT COUNT(*) FROM modules m WHERE m.class_id=g.class_id AND m.catalog_id IS NULL)) AS modules
  FROM student_groups g ORDER BY g.niveau,g.filiere,g.specialite`).all()));
// Re-run the automatic matching for groups linked to a class without teacher modules.
function rematchGroups() {
  const modCount = classModCount;
  let linked = 0, removed = 0;
  tx(() => {
    for (const g of db.prepare('SELECT * FROM student_groups').all()) {
      if (g.manual) continue;   // groups linked by hand are never touched
      const cid = findClass(g.niveau, g.filiere, g.specialite);
      if (!cid || cid === g.class_id || !modCount(cid)) continue;
      db.prepare('UPDATE student_groups SET class_id=? WHERE gkey=?').run(cid, g.gkey);
      db.prepare('UPDATE students SET class_id=? WHERE gkey=?').run(cid, g.gkey); linked++;
      const old = g.class_id;   // drop the empty class the import had created
      if (classModCount(old) === 0 && !db.prepare('SELECT 1 FROM student_groups WHERE class_id=?').get(old) && !db.prepare('SELECT 1 FROM students WHERE class_id=?').get(old)
        && !db.prepare('SELECT 1 FROM modules WHERE class_id=?').get(old) && !db.prepare('SELECT 1 FROM attendance WHERE class_id=?').get(old))
        removed += Number(db.prepare('DELETE FROM classes WHERE id=?').run(old).changes);
    }
  });
  return { linked, removed };
}
app.post('/api/student-groups/rematch', admin, (req, res) => res.json({ ok: 1, ...rematchGroups() }));
app.patch('/api/student-groups', admin, (req, res) => {
  const key = String(req.body.gkey || ''), cid = +req.body.class_id;
  if (!db.prepare('SELECT 1 FROM student_groups WHERE gkey=?').get(key) || !db.prepare('SELECT 1 FROM classes WHERE id=?').get(cid)) return bad(res, 'Group or class not found');
  let moved = 0;
  tx(() => { db.prepare('UPDATE student_groups SET class_id=?,manual=1 WHERE gkey=?').run(cid, key); moved = Number(db.prepare('UPDATE students SET class_id=? WHERE gkey=?').run(cid, key).changes); });
  res.json({ ok: 1, moved });
});
app.delete('/api/students/:id', admin, (req, res) => {
  db.prepare('DELETE FROM attendance WHERE student_id=?').run(+req.params.id);
  db.prepare('DELETE FROM students WHERE id=?').run(+req.params.id); res.json({ ok: 1 });
});

// ---- admin: today, QR, settings, report
app.get('/api/admin/today', admin, (req, res) => {
  const d = today();
  const rows = db.prepare(`SELECT u.id,u.name,c.status,c.checked_at FROM users u
    LEFT JOIN checkins c ON c.teacher_id=u.id AND c.date=? WHERE u.role='teacher' AND u.active=1 ORDER BY u.name`).all(d);
  res.json({ date: d, teachers: rows.map(r => ({ ...r, status: r.status || 'absent' })) });
});
app.get('/api/admin/qr', admin, async (req, res) => {
  const d = today(), payload = JSON.stringify({ d, s: sig(d) });
  res.json({ date: d, img: await QR.toDataURL(payload, { width: 480, margin: 2 }), late: get('late_time') });
});
app.post('/api/admin/qr/rotate', admin, (req, res) => {
  const p = String(req.body.passphrase || '');
  set('qr_secret', p ? crypto.createHash('sha256').update(p).digest('hex') : crypto.randomBytes(32).toString('hex'));
  res.json({ ok: 1 });
});
app.post('/api/admin/late', admin, (req, res) => {
  if (!/^\d\d:\d\d$/.test(req.body.t || '')) return bad(res, 'Use HH:MM');
  set('late_time', req.body.t); res.json({ ok: 1 });
});
app.get('/api/admin/report', admin, (req, res) => {
  const d = today(), from = req.query.from || d, to = req.query.to || d, cid = String(req.query.class_id || '');
  const rows = db.prepare(`SELECT a.date,c.name AS class,COALESCE(m.name,'') AS module,s.name AS student,a.status,COALESCE(a.arrived_at,'') AS time,COALESCE(u.name,'') AS teacher
    FROM attendance a JOIN students s ON s.id=a.student_id JOIN classes c ON c.id=a.class_id LEFT JOIN users u ON u.id=a.teacher_id LEFT JOIN modules m ON m.id=a.module_id
    WHERE a.date BETWEEN ? AND ? AND (?='' OR a.class_id=?) ORDER BY a.date DESC,c.name,s.name`).all(from, to, cid, cid);
  if (!req.query.csv) return res.json(rows);
  const cell = v => '"' + (/^[=+\-@]/.test(String(v)) ? "'" : '') + String(v).replace(/"/g, '""') + '"';
  res.type('text/csv').attachment('attendance.csv').send(
    ['date,class,module,student,status,arrival_time,teacher', ...rows.map(r => [r.date, r.class, r.module, r.student, r.status, r.time, r.teacher].map(cell).join(','))].join('\n'));
});

// ---- admin: teacher status report (still teaching / quit / no modules)
app.get('/api/admin/teachers-report', admin, (req, res) => {
  const rows = db.prepare(`SELECT u.id,u.name,u.matricule,u.email,u.active,
    (SELECT COUNT(*) FROM modules m WHERE m.teacher_id=u.id) AS modules,
    COALESCE((SELECT group_concat(m.name||' - '||c.name,' | ') FROM modules m JOIN classes c ON c.id=m.class_id WHERE m.teacher_id=u.id),'') AS module_list,
    COALESCE((SELECT MAX(date) FROM checkins k WHERE k.teacher_id=u.id),'') AS last_checkin,
    COALESCE((SELECT MAX(date) FROM attendance a WHERE a.teacher_id=u.id),'') AS last_attendance
    FROM users u WHERE u.role='teacher' ORDER BY u.name`).all()
    .map(r => ({ ...r, status: !r.active ? 'quit' : r.modules ? 'teaching' : 'none' }));
  const f = String(req.query.status || ''), out = f ? rows.filter(r => r.status === f) : rows;
  if (!req.query.csv) return res.json(out);
  const label = { teaching: 'Still teaching', quit: 'Quit (disabled)', none: 'Active, no modules' };
  const cell = v => '"' + (/^[=+\-@]/.test(String(v)) ? "'" : '') + String(v ?? '').replace(/"/g, '""') + '"';
  res.type('text/csv').attachment('teachers-report.csv').send('\ufeff' +
    ['name,login,status,modules,module_list,last_checkin,last_attendance',
      ...out.map(r => [r.name, r.matricule || r.email || '', label[r.status], r.modules, r.module_list, r.last_checkin, r.last_attendance].map(cell).join(','))].join('\n'));
});

// ---- academic years, semesters and teacher presence (check-ins by day, week and semester)
// An academic year runs from September to August and has two semesters (editable dates). Odd curriculum semesters (S1, S3, S5)
// belong to semester 1 of the year, even ones (S2, S4, S6) to semester 2. The teacher/module program of the current year is
// copied into year_modules whenever it changes, so a past year keeps the program it really had.
db.exec('CREATE TABLE IF NOT EXISTS year_modules(year TEXT,teacher_id INTEGER,teacher_name TEXT,matricule TEXT,module TEXT,class TEXT,semester INTEGER)');
const pad2 = n => String(n).padStart(2, '0');
const ayOf = ds => { const [y, m] = ds.split('-').map(Number); return m >= 9 ? `${y}/${y + 1}` : `${y - 1}/${y}`; };
const curAY = () => ayOf(today());
const dayAdd = (ds, n) => { const [y, m, d] = ds.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`; };
const dow = ds => { const [y, m, d] = ds.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };   // 0 = Sunday
const validAY = v => /^\d{4}\/\d{4}$/.test(v) && +v.slice(5) === +v.slice(0, 4) + 1;
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !isNaN(Date.parse(v));
const semDates = (ay, n) => {
  const saved = get(`sem:${ay}:${n}`);
  if (saved) { const [from, to] = saved.split('|'); return { from, to }; }
  const y = +ay.slice(0, 4);
  return n === 1 ? { from: `${y}-09-01`, to: `${y + 1}-01-31` } : { from: `${y + 1}-02-01`, to: `${y + 1}-06-30` };
};
function refreshSnapshot() {
  try {
    const ay = curAY();
    tx(() => {
      db.prepare('DELETE FROM year_modules WHERE year=?').run(ay);
      db.prepare(`INSERT INTO year_modules(year,teacher_id,teacher_name,matricule,module,class,semester)
        SELECT ?,m.teacher_id,u.name,COALESCE(u.matricule,u.email),m.name,c.name,m.semester FROM modules m JOIN classes c ON c.id=m.class_id LEFT JOIN users u ON u.id=m.teacher_id`).run(ay);
    });
  } catch (e) { console.error('Could not save the yearly program:', e.message); }
}
const hmLocal = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function presenceData(ay, sem) {
  const { from, to } = semDates(ay, sem);
  const rows = ay === curAY()
    ? db.prepare('SELECT m.teacher_id,m.name AS module,c.name AS class,m.semester FROM modules m JOIN classes c ON c.id=m.class_id').all()
    : db.prepare('SELECT teacher_id,module,class,semester FROM year_modules WHERE year=?').all(ay);
  const mods = rows.filter(m => (m.semester % 2 === 1) === (sem === 1));
  const checks = db.prepare('SELECT teacher_id,date,checked_at,status FROM checkins WHERE date BETWEEN ? AND ?').all(from, to);
  const ids = new Set([...mods.map(m => m.teacher_id), ...checks.map(c => c.teacher_id)]);
  const users = db.prepare("SELECT id,name,email,matricule,active FROM users WHERE role='teacher' ORDER BY name").all().filter(u => ids.has(u.id));
  const weeks = []; let st = dayAdd(from, -dow(from));
  while (st <= to) { const days = [0, 1, 2, 3, 4, 5, 6].map(i => dayAdd(st, i)); weeks.push({ n: weeks.length + 1, start: days[0], end: days[6], days }); st = dayAdd(st, 7); }
  const teachers = users.map(u => {
    const marks = {}; let present = 0, late = 0;
    checks.filter(c => c.teacher_id === u.id).forEach(c => { marks[c.date] = { s: c.status === 'late' ? 'late' : 'present', t: hmLocal(c.checked_at) }; c.status === 'late' ? late++ : present++; });
    return { id: u.id, matricule: u.matricule || u.email || '', name: u.name, active: !!u.active, present, late, marks,
      modules: mods.filter(m => m.teacher_id === u.id).map(m => ({ name: m.module, class: m.class, semester: m.semester })).sort((a, b) => a.name.localeCompare(b.name)) };
  });
  return { year: ay, semester: sem, from, to, current: ay === curAY(), weeks, teachers };
}
const parseYS = req => {
  const ay = String(req.query.year || curAY()), sem = +req.query.semester || 1;
  if (!validAY(ay) || ![1, 2].includes(sem)) return { error: 'Invalid year or semester' };
  const d = semDates(ay, sem); if (!(d.from <= d.to)) return { error: 'Invalid semester dates' };
  return presenceData(ay, sem);
};
app.get('/api/years', admin, (req, res) => {
  let y = +curAY().slice(0, 4);
  const first = db.prepare('SELECT MIN(date) AS d FROM checkins').get().d; if (first) y = Math.min(y, +ayOf(first).slice(0, 4));
  const last = +curAY().slice(0, 4), out = [];
  for (let k = last; k >= Math.min(y, last - 5); k--) { const label = `${k}/${k + 1}`; out.push({ label, current: label === curAY(), s1: semDates(label, 1), s2: semDates(label, 2) }); }
  res.json(out);
});
app.post('/api/years/dates', admin, (req, res) => {
  const ay = String(req.body.year || ''), b = req.body;
  if (!validAY(ay)) return bad(res, 'Invalid year');
  for (const n of [1, 2]) { const d = b['s' + n]; if (!d || !isDate(d.from) || !isDate(d.to) || d.from > d.to) return bad(res, `Semester ${n}: check the dates`); }
  if (b.s1.to >= b.s2.from) return bad(res, 'Semester 2 must start after semester 1 ends');
  for (const n of [1, 2]) set(`sem:${ay}:${n}`, `${b['s' + n].from}|${b['s' + n].to}`);
  res.json({ ok: 1 });
});
app.get('/api/admin/teacher-presence', admin, (req, res) => { const d = parseYS(req); d.error ? bad(res, d.error) : res.json(d); });
app.get('/api/admin/teacher-presence.xlsx', admin, async (req, res) => {
  const D = parseYS(req); if (D.error) return bad(res, D.error);
  let ExcelJS; try { ExcelJS = require('exceljs'); } catch { return bad(res, 'Excel export needs the exceljs package: run npm install', 500); }
  const wb = new ExcelJS.Workbook(), F = { name: 'Arial', size: 10 }, H = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  const fill = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } }), GREEN = 'FF1F6F54', fmt = d => d.slice(8) + '/' + d.slice(5, 7);
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], N = D.teachers.length, last = 3 + N;
  const head = (ws, vals, row = 3) => { const r = ws.getRow(row); vals.forEach((v, i) => { const c = r.getCell(i + 1); c.value = v; c.font = H; c.fill = fill(GREEN); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; }); r.height = 30; };
  const title = (ws, t, sub) => { ws.getCell('A1').value = t; ws.getCell('A1').font = { name: 'Arial', size: 12, bold: true }; ws.getCell('A2').value = sub; ws.getCell('A2').font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF666666' } }; };
  const head1 = `Teacher presence - Année académique ${D.year} - Semester ${D.semester} (${fmt(D.from)}/${D.from.slice(0, 4)} to ${fmt(D.to)}/${D.to.slice(0, 4)})`;
  const legend = 'P = checked in on time, L = late, blank = no check-in recorded. Weekend columns are shaded. Hover a mark to see the check-in time.';
  const sum = wb.addWorksheet('Summary'), mod = wb.addWorksheet('Teachers & modules');
  const names = D.weeks.map(w => `W${pad2(w.n)} ${w.start}`);
  D.weeks.forEach((w, wi) => {
    const ws = wb.addWorksheet(names[wi]);
    title(ws, `${head1} - Week ${w.n}: ${fmt(w.start)} to ${fmt(w.end)}`, legend);
    head(ws, ['Matricule', 'Teacher', ...w.days.map((d, i) => `${DAYS[i]} ${fmt(d)}`), 'Days present']);
    D.teachers.forEach((t, ti) => {
      const r = ws.getRow(4 + ti); r.getCell(1).value = t.matricule; r.getCell(2).value = t.name;
      w.days.forEach((d, i) => {
        const c = r.getCell(3 + i), m = t.marks[d], out = d < D.from || d > D.to;
        c.alignment = { horizontal: 'center' };
        if (m) { c.value = m.s === 'late' ? 'L' : 'P'; c.fill = fill(m.s === 'late' ? 'FFFFE0A3' : 'FFCDEBD6'); c.note = 'Checked in at ' + m.t; }
        else if (out) c.fill = fill('FFD9D9D9'); else if (i >= 5) c.fill = fill('FFF2F2F2');
      });
      r.getCell(10).value = { formula: `COUNTIF(C${4 + ti}:I${4 + ti},"P")+COUNTIF(C${4 + ti}:I${4 + ti},"L")` }; r.getCell(10).alignment = { horizontal: 'center' };
      r.eachCell({ includeEmpty: true }, c => { c.font = c.font && c.font.bold ? c.font : F; });
    });
    ws.getColumn(1).width = 14; ws.getColumn(2).width = 32; for (let i = 3; i <= 10; i++) ws.getColumn(i).width = 11;
    for (let i = 5; i <= 6; i++) ws.getRow(3).getCell(3 + i).fill = fill('FF6B7B74');
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 3 }];
  });
  // summary
  title(sum, head1, legend);
  head(sum, ['Matricule', 'Teacher', 'Account', 'Modules this semester', 'Days on time', 'Days late', 'Days present', ...D.weeks.map(w => `W${w.n}\n${fmt(w.start)}`)]);
  D.teachers.forEach((t, ti) => {
    const r = sum.getRow(4 + ti), row = 4 + ti, q = i => `'${names[i]}'`;
    r.getCell(1).value = t.matricule; r.getCell(2).value = t.name; r.getCell(3).value = t.active ? 'Active' : 'Disabled'; r.getCell(4).value = t.modules.length;
    r.getCell(5).value = D.weeks.length ? { formula: D.weeks.map((w, i) => `COUNTIF(${q(i)}!C${row}:I${row},"P")`).join('+') } : 0;
    r.getCell(6).value = D.weeks.length ? { formula: D.weeks.map((w, i) => `COUNTIF(${q(i)}!C${row}:I${row},"L")`).join('+') } : 0;
    r.getCell(7).value = { formula: `E${row}+F${row}` };
    D.weeks.forEach((w, i) => { r.getCell(8 + i).value = { formula: `${q(i)}!J${row}` }; r.getCell(8 + i).alignment = { horizontal: 'center' }; });
    r.eachCell({ includeEmpty: true }, c => { c.font = F; });
    if (!t.active) r.getCell(3).fill = fill('FFFCE4E4');
  });
  sum.getColumn(1).width = 14; sum.getColumn(2).width = 32; sum.getColumn(3).width = 10; for (let i = 4; i <= 7; i++) sum.getColumn(i).width = 12; for (let i = 8; i < 8 + D.weeks.length; i++) sum.getColumn(i).width = 7;
  sum.views = [{ state: 'frozen', xSplit: 2, ySplit: 3 }];
  // teachers and their modules
  title(mod, `${head1} - teachers and modules`, 'Modules taught this semester (curriculum semesters ' + (D.semester === 1 ? 'S1, S3, S5' : 'S2, S4, S6') + '). Past years keep the program they had.');
  head(mod, ['Matricule', 'Teacher', 'Module', 'Class', 'Curriculum semester']);
  let mr = 4;
  D.teachers.forEach(t => (t.modules.length ? t.modules : [{ name: '(no module this semester)', class: '', semester: '' }]).forEach(m => {
    const r = mod.getRow(mr++); [t.matricule, t.name, m.name, m.class, m.semester ? 'S' + m.semester : ''].forEach((v, i) => { r.getCell(i + 1).value = v; r.getCell(i + 1).font = F; });
  }));
  [14, 32, 46, 58, 12].forEach((w, i) => { mod.getColumn(i + 1).width = w; }); mod.views = [{ state: 'frozen', ySplit: 3 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="teacher-presence_${D.year.replace('/', '-')}_S${D.semester}.xlsx"`);
  await wb.xlsx.write(res); res.end();
});

// ---- teacher: QR check-in
app.get('/api/checkin/today', teacher, (req, res) =>
  res.json(db.prepare('SELECT status,checked_at FROM checkins WHERE teacher_id=? AND date=?').get(req.user.id, today()) || {}));
app.post('/api/checkin', teacher, rate({ windowMs: 60e3, limit: 20 }), (req, res) => {
  let p; try { p = JSON.parse(req.body.payload); } catch { return bad(res, 'That is not a valid QR code'); }
  const d = today();
  if (!p || p.d !== d) return bad(res, "This QR code is not for today");
  const a = Buffer.from(String(p.s)), b = Buffer.from(sig(d));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad(res, 'That is not a valid QR code');
  const status = hm() > get('late_time') ? 'late' : 'present';
  try {
    db.prepare('INSERT INTO checkins(teacher_id,date,checked_at,status,ip) VALUES(?,?,?,?,?)')
      .run(req.user.id, d, new Date().toISOString(), status, req.ip);
  } catch { return bad(res, 'You already checked in today'); }
  res.json({ status });
});

// ---- teacher: student attendance sheet (today only)
const target = (req, src) => {
  const mid = +src.module_id || 0;
  if (mid) { const m = db.prepare('SELECT class_id FROM modules WHERE id=? AND teacher_id=?').get(mid, req.user.id); return m && { cid: m.class_id, mid }; }
  return db.prepare('SELECT 1 FROM modules WHERE teacher_id=?').get(req.user.id) ? null : { cid: +src.class_id, mid: 0 };
};
app.get('/api/sheet', teacher, (req, res) => {
  const t = target(req, req.query); if (!t) return bad(res, 'Choose one of your modules', 403);
  res.json(db.prepare(`SELECT s.id,s.name,s.matricule,s.niveau,s.filiere,s.specialite,s.sit,CASE WHEN a.status='absent' THEN 'absent' ELSE 'present' END AS status,COALESCE(a.arrived_at,'') AS arrived_at FROM students s
    LEFT JOIN attendance a ON a.student_id=s.id AND a.date=? AND a.class_id=s.class_id AND a.module_id=?
    WHERE s.class_id=? ORDER BY s.name`).all(today(), t.mid, t.cid));
});
// Every saved day of one module: the teacher sees who was present or absent, and when they arrived.
app.get('/api/history', teacher, (req, res) => {
  const t = target(req, req.query); if (!t) return bad(res, 'Choose one of your modules', 403);
  const rows = db.prepare(`SELECT a.date,s.id AS student_id,s.name,s.matricule,s.sit,CASE WHEN a.status='absent' THEN 'absent' ELSE 'present' END AS status,COALESCE(a.arrived_at,'') AS arrived_at
    FROM attendance a JOIN students s ON s.id=a.student_id WHERE a.class_id=? AND a.module_id=? ORDER BY a.date DESC,s.name`).all(t.cid, t.mid);
  if (!req.query.csv) return res.json(rows);
  const cell = v => '"' + (/^[=+\-@]/.test(String(v)) ? "'" : '') + String(v ?? '').replace(/"/g, '""') + '"';
  res.type('text/csv').attachment('attendance-history.csv').send('\ufeff' +
    ['date,matricule,student,status,arrival_time', ...rows.map(r => [r.date, r.matricule || '', r.name, r.status, r.arrived_at].map(cell).join(','))].join('\n'));
});
app.post('/api/sheet', teacher, (req, res) => {
  const d = today(), recs = req.body.records, t = target(req, req.body);
  if (!t) return bad(res, 'Choose one of your modules', 403);
  if (!db.prepare('SELECT 1 FROM checkins WHERE teacher_id=? AND date=?').get(req.user.id, d))
    return bad(res, 'Scan the QR code to check in before taking attendance', 403);
  if (!Array.isArray(recs) || recs.some(r => !TSTATUS.includes(r.status))) return bad(res, 'Invalid records');
  const up = db.prepare(`INSERT INTO attendance(class_id,module_id,date,student_id,status,teacher_id,arrived_at)
    SELECT ?,?,?,id,?,?,? FROM students WHERE id=? AND class_id=?
    ON CONFLICT(class_id,module_id,date,student_id) DO UPDATE SET status=excluded.status,teacher_id=excluded.teacher_id,arrived_at=excluded.arrived_at`);
  const tm = r => r.status === 'present' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.arrived_at || '') ? r.arrived_at : null;   // optional arrival time
  tx(() => recs.forEach(r => up.run(t.cid, t.mid, d, r.status, req.user.id, tm(r), +r.student_id, t.cid)));
  res.json({ saved: recs.length });
});

const impm = process.argv.indexOf('--import-modules');
if (impm > -1) {
  const rows = JSON.parse(require('fs').readFileSync(process.argv[impm + 1] || 'modules_catalog.json', 'utf8')), r = importCatalog(rows);
  console.log(`Module list: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped, ${r.new_classes.length} new classes, ${r.linked} teacher modules linked, ${r.groups.linked} student groups re-linked.`);
  process.exit(0);
}
try { linkModules(); } catch (e) { console.error(e.message); }
refreshSnapshot();
app.listen(process.env.PORT || 3000, () => console.log('Presence running on http://localhost:' + (process.env.PORT || 3000)));

# Presence

Teacher and student attendance with an admin dashboard and a daily signed QR code.

## Run
Requires Node.js 22.5 or newer (uses the built-in `node:sqlite`, so nothing needs compiling).

```
npm install
npm run seed   # optional demo data (teacher@school.dz / teacher123)
npm start      # http://localhost:3000
```
First login: `admin@school.dz` / `admin123` (you must change it immediately).
Phones need HTTPS to use the camera (use a reverse proxy or a tunnel). Set `COOKIE_SECURE=1` behind HTTPS.

## Import teachers and modules
`teachers.json` holds the 156 teachers and their modules from `Liste_des_enseignants.xls`. Stop the server, then run
`npm run import`. It creates one account per teacher (login = matricule) with a random temporary password, saved in
`credentials.csv`. Hand the passwords out, then delete that file. Each filière/année becomes a class; add its students
from the admin "Classes & students" tab. Teachers with modules take attendance per module.

## How the QR works
Payload = `{ d: "YYYY-MM-DD", s: HMAC_SHA256(secret, d) }`. The server checks the teacher's login, that `d` equals
today's date on the server, the signature (timing-safe), and one check-in per teacher per day. Changing the secret
(optionally from a passphrase) invalidates the current QR. Teachers check in late after the configured time.

## Changing a module's teacher
Admin > Modules lists every module with its teacher. Use "Change teacher" to give a module to another teacher or to a new account (a temporary password is shown once). Tick "Move all modules" to hand over everything a departing teacher had, and "Disable account" to lock the old one. Past attendance records keep the original teacher's name. Teachers > Edit changes a teacher's name or login.

## Teacher report
Admin > Teacher report shows every teacher as Still teaching (active with modules), Quit (account disabled) or Active with no modules, with last check-in and last attendance dates. Filter by status and download it as CSV (`GET /api/admin/teachers-report?status=&csv=1`). A teacher counts as quit when the account is disabled, so disable the account when someone leaves.

## Importing students
Admin > Classes & students > Import students takes your Excel file (.xlsx, .xls) chosen with the file button, rows pasted from Excel, or a CSV/TSV file with the header `Mat. Etudiant, Nom, Prénom, Libellé domaine, Libellé filière, specialité, Code niveau`. Students are matched by matricule (re-importing updates them). `Code niveau` gives the year (1, 2 or 3 in L1/L2/L3/M1/M2) and the degree. Each (level, filière, spécialité) group is linked automatically to the class named like the teachers' modules, for example "Première année (Droit Pénal Master)". If nothing matches, a new class is created and flagged: fix it in the Student groups table (it moves all students of the group). A teacher only sees the students of the class of the module they open, so year and speciality are respected. The old `name, class` format still works.

If a student group shows "no teacher module", its filière name matched no class of the teacher list, so the import created an empty class. Use "Re-match groups without teacher module" (it knows the common name differences, such as Langue anglaise = Littérature et langues étrangères and Sciences économiques = Tronc Commun SEGSC), or pick the class by hand in the Linked class column. Extra rules go in the `ALIASES` list in `server.js`.

The matching of student groups to teacher classes was checked against the 39 groups of the faculty's student file and the teacher list: 35 groups link to a class with modules. Informatique (Réseaux et sécurité), Sciences de gestion (Gestion publique) and Presse imprimée et électronique have no class in the teacher list. See `students_vs_teachers_comparison.xlsx`.

Teacher attendance sheet: after choosing a module, the teacher sees every student of that module's class (same year and speciality) with matricule, level, spécialité and registration status (Sit. d'ins), a search box, and the attendance buttons.

Teacher attendance: each student is Present or Absent (no "late"), with Mark all present / Mark all absent (applied to the students currently shown), a filter Validée / Générée, a search box and an optional arrival time per student (or one time for all present students). The History tab lists every saved day of a module (by day and by student, with a CSV download). Admin reports include the arrival time.

## Teacher presence by academic year
Admin > Teacher presence: pick an academic year (September to August, listed like "Année Académique: 2026/2027"), then Semester 1 or 2, then a week. The table shows each teacher's check-ins per day (P on time, L late, blank = none) with week and semester totals. "Download Excel" gives one workbook per semester: a Summary sheet (days on time, late and present per teacher, plus days present per week), a Teachers & modules sheet, and one sheet per week (Sunday to Saturday, a note on each mark shows the check-in time). Semester dates default to 1 Sep - 31 Jan and 1 Feb - 30 Jun and can be changed per year. Odd curriculum semesters (S1, S3, S5) belong to semester 1 of the year, even ones (S2, S4, S6) to semester 2. The teacher/module program of the current year is saved automatically whenever modules or teachers change, so a past year keeps the program it had. Run `npm install` once: the Excel export uses the `exceljs` package (pure JavaScript).

## Official list of modules (Liste des modules)
`modules_catalog.json` holds the 798 modules of the faculty's "Liste des modules" file (academic year 2026/2027). Load it once with `npm run import:modules` (stop the server first), or choose the Excel file in Admin > Programs > Import the list of modules (also for next year's list). Each module is saved in its class (filière & année), the missing classes are created, the teachers' modules are linked to it (same class, semester and name), and student groups are moved to the class that has modules. A student follows every module of their class; the Programs tab shows, for each class, its student groups, its students, and every module with its teacher or an "Assign teacher" button. In Admin > Modules, "Assign a module" now picks the class, then the module from the list, then the teacher. Student groups you link by hand are never moved by the automatic re-match. "Download Excel" in Programs exports class, module, teacher and student count.

## Importing teachers and their modules from Excel
Admin > Teachers > Import teachers and their modules: choose the "Liste des enseignants" file (.xls or .xlsx). New teachers get an account (login = matricule) with a random temporary password; the passwords are downloaded as `credentials.csv` right after the import (hand them out, then delete the file). Teachers and modules already in the app are not changed or duplicated, so the file can be imported again, for example after adding teachers. New modules are linked to the official list of modules automatically. `npm run import` still does the same from `teachers.json`.

## Example files for each import
`public/examples/` holds one example Excel file per import, also linked from the import screens ("Download an example file"): `exemple_import_enseignants.xlsx` (teachers with their modules), `exemple_import_etudiants.xlsx` (students, with extra columns that are ignored) and `exemple_import_modules.xlsx` (list of modules). Each has a Notes sheet that explains the columns. Replace the EXEMPLE rows with your own.

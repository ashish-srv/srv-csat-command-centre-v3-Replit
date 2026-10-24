const HEADERS = ['birthday_contact_id','organisation','poc_name','designation','salutation','birthday_mm_dd','email','whatsapp_number','cluster','internal_poc_emails','gift_eligible','delivery_address','notes'];
export async function buildBirthdayWorkbook(directory, contacts = []) {
  const module = await import('exceljs'), ExcelJS = module.default || module;
  const book = new ExcelJS.Workbook(); book.creator = 'SRV Media';
  const sheet = book.addWorksheet('Birthday Contacts', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  sheet.columns = HEADERS.map((header, index) => ({ header, key: header, width: [1,9,11,12].includes(index) ? 36 : 25 }));
  const reference = book.addWorksheet('Internal POC Reference');
  reference.columns = [{ header: 'Internal POC Name', key: 'name', width: 30 }, { header: 'Email (use | between owners)', key: 'email', width: 46 }];
  for (const person of directory.internalPocs.filter(p => p.active !== false && p.email)) reference.addRow({ name: person.name, email: person.email });
  const instructions = book.addWorksheet('Instructions');
  instructions.getColumn(1).width = 110;
  for (const text of ['SRV Birthday Centre — Excel Upload','Fill only Birthday Contacts. Internal POC Reference is for lookup.',
    'Birthday: MM-DD (10-24), YYYY-MM-DD or an actual Excel date. Birth year is not required.',
    'Separate multiple Internal POC email addresses with |. All must already exist and be active.',
    'Leave birthday_contact_id empty for new contacts. Export existing contacts to obtain IDs for updates.',
    'New contacts always have Email Wishes OFF and WhatsApp Wishes OFF. Enable explicitly in Birthday Centre.',
    'Use a standard cluster name. Birthday-only organisations do not require CSAT clients or projects.',
    'Gift eligibility: Yes or No. No disables gift follow-ups, not separately enabled birthday wishes.',
    'Limit: 500 data rows. Duplicate contacts and invalid rows must be corrected before importing.',
    'Excel upload never changes CSAT weights, feedback, project services or annual gift/wish history.']) instructions.addRow([text]);
  for (const c of contacts) sheet.addRow([c.id, c.organization, c.name, c.designation, c.salutation, c.birthday, c.email, c.whatsapp,
    directory.clusters.find(cluster => cluster.id === c.clusterId)?.name || '', c.internalPocIds.map(id => directory.internalPocs.find(p => p.id === id)?.email || '').filter(Boolean).join(' | '), c.giftEligible ? 'Yes' : 'No', c.address, c.notes]);
  const sources = book.addWorksheet('Sources'); sources.state = 'veryHidden';
  directory.clusters.forEach((cluster, i) => sources.getCell(i + 1, 1).value = cluster.name);
  const owners = directory.internalPocs.filter(p => p.active !== false && p.email);
  owners.forEach((person, i) => sources.getCell(i + 1, 2).value = person.email);
  for (let row = 2; row <= 501; row++) {
    for (const column of [1,6,7,8,10]) sheet.getCell(row, column).numFmt = '@';
    sheet.getCell(row, 11).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Yes,No"'], showErrorMessage: true, error: 'Choose Yes or No.' };
    if (directory.clusters.length) sheet.getCell(row, 9).dataValidation = { type: 'list', allowBlank: true, formulae: [`Sources!$A$1:$A$${directory.clusters.length}`] };
    // A single owner can be selected; multiple owners can be pasted using |.
    if (owners.length) sheet.getCell(row, 10).dataValidation = { type: 'list', allowBlank: true, formulae: [`Sources!$B$1:$B$${owners.length}`], showErrorMessage: false };
  }
  for (const tab of [sheet, reference, instructions]) {
    tab.eachRow(row => { row.height = 27; row.eachCell(cell => { cell.font = { name: 'Verdana', size: 11, color: { argb: 'FF25272B' } }; cell.alignment = { vertical: 'middle', wrapText: true }; }); });
    tab.getRow(1).height = 34;
    tab.getRow(1).eachCell(cell => { cell.font = { name: 'Verdana', bold: true, size: 11, color: { argb: 'FF881722' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE6E8' } }; });
  }
  sheet.autoFilter = `A1:M${Math.max(2, contacts.length + 1)}`;
  return book;
}
export async function downloadBirthdayWorkbook(directory, contacts = []) {
  const book = await buildBirthdayWorkbook(directory, contacts), buffer = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = contacts.length ? 'SRV_Birthday_Contacts.xlsx' : 'SRV_Birthday_Upload_Template.xlsx';
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}
function value(cell) {
  if (cell.type === 6 || cell.value?.formula || cell.value?.sharedFormula) throw new Error('Formula cells are not supported in birthday upload. Paste values first.');
  const raw = cell.value;
  if (raw instanceof Date) return raw.toISOString().slice(5, 10);
  return typeof raw === 'object' && raw ? raw.text || raw.richText?.map(v => v.text).join('') || '' : String(raw ?? '').trim();
}
export async function parseBirthdayWorkbook(buffer, data) {
  const module = await import('exceljs'), ExcelJS = module.default || module;
  const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
  const sheet = book.getWorksheet('Birthday Contacts');
  if (!sheet || HEADERS.some((header, i) => value(sheet.getCell(1, i + 1)) !== header)) throw new Error('Use the Birthday Centre template with unchanged column headings.');
  if (sheet.rowCount > 501) throw new Error('Upload at most 500 data rows.');
  const contacts = [], errors = [];
  for (let row = 2; row <= sheet.rowCount; row++) {
    try {
      const values = HEADERS.map((_, i) => value(sheet.getCell(row, i + 1)));
      if (values.every(v => !v)) continue;
      const r = Object.fromEntries(HEADERS.map((header, i) => [header, values[i]]));
      const existing = r.birthday_contact_id ? data.contacts.find(c => c.id === r.birthday_contact_id) : null;
      if (r.birthday_contact_id && !existing) throw new Error('Birthday contact ID is not available.');
      const cluster = r.cluster ? data.directory.clusters.find(c => c.name.toLowerCase() === r.cluster.toLowerCase()) : null;
      if (r.cluster && !cluster) throw new Error(`Unknown standard cluster: ${r.cluster}`);
      const emails = r.internal_poc_emails.split('|').map(e => e.trim().toLowerCase()).filter(Boolean);
      const owners = emails.map(email => data.directory.internalPocs.find(p => p.active !== false && p.email?.toLowerCase() === email));
      if (!owners.length || owners.some(p => !p)) throw new Error('Assign valid Internal POC emails separated by |.');
      if (r.gift_eligible && !/^(yes|no)$/i.test(r.gift_eligible)) throw new Error('gift_eligible must be Yes or No.');
      contacts.push({ ...(existing || {}), name: r.poc_name, organization: r.organisation, designation: r.designation, salutation: r.salutation,
        birthday: r.birthday_mm_dd, email: r.email, whatsapp: r.whatsapp_number, clusterId: cluster?.id || null,
        internalPocIds: [...new Set(owners.map(p => p.id))], giftEligible: r.gift_eligible.toLowerCase() === 'yes', address: r.delivery_address, notes: r.notes,
        ...(!existing ? { emailEnabled: false, whatsappEnabled: false, whatsappOptIn: false, active: true, linkedPocIds: [] } : {}) });
    } catch (e) { errors.push(`Row ${row}: ${e.message}`); }
  }
  if (!contacts.length && !errors.length) errors.push('The workbook contains no birthday contacts.');
  return { contacts, errors };
}

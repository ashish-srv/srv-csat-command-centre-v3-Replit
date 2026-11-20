const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {build}=require('esbuild');

async function main(){
  const {chromium}=require(process.env.CSAT_BROWSER_TEST_MODULE||'playwright');
  const output=path.resolve('outputs/broadcast-export-qa');fs.mkdirSync(output,{recursive:true});
  await build({entryPoints:['scripts/fixtures/broadcast-export-ui.jsx'],bundle:true,outfile:path.join(output,'ui.js'),jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
  const browser=await chromium.launch({headless:true,...(process.env.CSAT_BROWSER_TEST_EXECUTABLE?{executablePath:process.env.CSAT_BROWSER_TEST_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1366,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>');
    await page.evaluate(data=>{window.__broadcastReportData=data;},JSON.parse(fs.readFileSync(path.join(output,'data.json'))));
    await page.addStyleTag({path:path.join(output,'ui.css')});await page.addScriptTag({path:path.join(output,'ui.js')});
    const replies=page.locator('#broadcast-replies');await replies.scrollIntoViewIfNeeded();
    const from=replies.getByLabel('From date'),to=replies.getByLabel('To date');
    await from.fill('2026-11-01');await to.fill('2026-11-20');
    for(const width of [1366,768,375]){
      await page.setViewportSize({width,height:900});await replies.locator('.date-range-inputs').scrollIntoViewIfNeeded();
      const geometry=await replies.locator('.date-range-inputs').evaluate(el=>{
        const parent=el.getBoundingClientRect();return {parent:{x:parent.x,width:parent.width},children:[...el.children].map(child=>{const r=child.getBoundingClientRect();return {x:r.x,width:r.width,height:r.height,right:r.right,tag:child.tagName};}),scroll:document.documentElement.scrollWidth,viewport:window.innerWidth};
      });
      assert.ok(geometry.parent.x>=0&&geometry.parent.x+geometry.parent.width<=width+1,`date range fits at ${width}`);
      for(let i=1;i<geometry.children.length;i++) assert.ok(geometry.children[i].x>=geometry.children[i-1].right-1,'date fields and reset never overlap');
      for(const input of geometry.children.filter(c=>c.tag==='INPUT')){assert.ok(input.height<=35);assert.ok(input.width>=100,'date text has room to display');}
      const reset=replies.getByRole('button',{name:'Reset date range'});assert.ok(await reset.isVisible());
      await page.screenshot({path:path.join(output,`date-range-${width}.png`),fullPage:false});
    }
    await replies.getByRole('button',{name:'Reset date range'}).click();assert.equal(await from.inputValue(),'');assert.equal(await to.inputValue(),'');
    await from.fill('2026-11-01');await replies.getByRole('button',{name:'Reset filters'}).click();assert.equal(await from.inputValue(),'');
    await page.setViewportSize({width:1366,height:900});
    const downloads=replies.locator('.report-downloads');
    const download=page.waitForEvent('download');await downloads.getByRole('button',{name:'HTML',exact:true}).click();
    const file=await download;assert.equal(file.suggestedFilename(),'WhatsApp_Broadcast_Replies_Delivery.html');await file.saveAs(path.join(output,'downloaded-report.html'));
    assert.ok((await page.evaluate(()=>window.__reportRequests)).at(-1).includes('section=replies'));
    const excelDownload=page.waitForEvent('download');await page.locator('#broadcast-history .report-downloads').getByRole('button',{name:'Excel',exact:true}).click();
    const excel=await excelDownload;assert.equal(excel.suggestedFilename(),'WhatsApp_Broadcast_History.xlsx');await excel.saveAs(path.join(output,'downloaded-history.xlsx'));
    // Exercise actual PDF button/pop-up behavior, then print the generated report.
    const popupEvent=page.waitForEvent('popup');await downloads.getByRole('button',{name:'PDF',exact:true}).click();const popup=await popupEvent;
    await popup.waitForSelector('h1');assert.equal(await popup.locator('h1').textContent(),'WhatsApp Broadcast Report');
    await popup.emulateMedia({media:'print'});assert.equal(await popup.locator('.chat-scroll').first().evaluate(el=>getComputedStyle(el).maxHeight),'none');
    await popup.pdf({path:path.join(output,'report.pdf'),preferCSSPageSize:true,printBackground:true});
    await popup.emulateMedia({media:'screen'});await popup.screenshot({path:path.join(output,'report.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS Chromium: desktop/mobile date geometry, clear/reset, filtered HTML and full-history Excel downloads, PDF popup and transcript print expansion.');
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

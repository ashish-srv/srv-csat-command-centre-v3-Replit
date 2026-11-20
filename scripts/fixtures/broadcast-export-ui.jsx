import React from 'react';
import { createRoot } from 'react-dom/client';
import WhatsAppBroadcasts from '../../src/components/WhatsAppBroadcasts.jsx';
import '../../src/styles.css';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const poc={id:id(3),name:'Contact A',salutation:'Contact A Sir',active:true,contactWhatsapp:'919876543210',clientId:id(1),clientName:'Client A',projectId:id(2),projectName:'Project A',clusterId:id(4)};
const data={directory:{clusters:[{id:id(4),name:'Cluster A'}],clients:[{id:id(1),name:'Client A',clusterId:id(4)}],projects:[{id:id(2),name:'Project A',clientId:id(1)}],clientPocs:[poc]},templates:[],campaigns:[{id:id(5),title:'Autumn Announcement',created_at:'2026-11-19T18:40:00Z',created_by:'admin@example.test',total:3,delivered:1,read:1,unconfirmed:0,replied:1,skipped:1,failed:1}],messaging:{enabled:true},senderConfigured:true};
window.__reportRequests=[];
window.fetch=async url=>{
  if(String(url).includes('/export?')) {
    window.__reportRequests.push(String(url));const query=new URLSearchParams(String(url).split('?')[1]);
    const result={...window.__broadcastReportData,section:query.get('section'),filters:{campaignId:query.get('campaignId')||'',from:query.get('from')||'',to:query.get('to')||'',search:query.get('search')||'',statuses:(query.get('statuses')||'').split(',').filter(Boolean),replies:(query.get('replies')||'').split(',').filter(Boolean)}};
    return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
  }
  const result=String(url).includes('/inbox?')?{recipients:[{id:id(6),title:'Autumn Announcement',phone:poc.contactWhatsapp,associations:[poc],status:'skipped',reason:'Active Feedback in Progress'}]}:data;
  return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
};
createRoot(document.getElementById('root')).render(<div className="broadcast-fixture" style={{maxWidth:1180,margin:'0 auto',padding:16}}><WhatsAppBroadcasts currentUser={{role:'super_admin'}} /></div>);

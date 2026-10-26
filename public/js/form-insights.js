// Aggregates stay in memory only; URLs remember question/scope/threshold/dates,
// never guest identities or raw answers. The server counts the entire result set.
"use strict";
var SahraFormInsights=(function(){
 var t=Sahra.t,el=Sahra.el,S=SahraStaff,root=null,partyId=null,data=null,error=null,loading=false,seq=0;
 var u=new URLSearchParams(location.search),state={question:u.get('fi_question')||'',scope:u.get('fi_scope')||'approved',cutoff:u.get('fi_cutoff')||'18',date_from:u.get('fi_from')||'',date_to:u.get('fi_to')||''};
 var draft=state.cutoff;
 function remember(){var url=new URL(location.href);[['fi_question','question'],['fi_scope','scope'],['fi_cutoff','cutoff'],['fi_from','date_from'],['fi_to','date_to']].forEach(function(x){if(state[x[1]])url.searchParams.set(x[0],state[x[1]]);else url.searchParams.delete(x[0]);});history.replaceState(null,'',url);}
 async function load(){var current=++seq;loading=true;error=null;draw();var q=SahraBooking.params({date_from:state.date_from,date_to:state.date_to});q.set('scope',state.scope);q.set('cutoff',state.cutoff);if(state.question)q.set('question',state.question);
  var r=await Sahra.api.get('/api/party/form-insights?'+q);if(current!==seq)return;loading=false;if(!r.ok)error=S.why(r);else{data=r.body;state.question=data.question||'';}draw();}
 function change(patch){Object.assign(state,patch);remember();load();}
 function metric(label,value){return el('div',{class:'fi-metric'},el('span',{class:'small muted',text:label}),el('strong',{text:value==null?'0':String(value)}));}
 function cell(value,head){return el(head?'th':'td',{text:String(value),attrs:head?{scope:'col'}:{}});}
 function number(n){return n==null?'':new Intl.NumberFormat(Sahra.lang()==='ar'?'ar-EG-u-nu-latn':'en-GB',{maximumFractionDigits:2}).format(n);}
 function csv(){var headers=[t('fi_answer'),t('fi_responses'),t('fi_places')],rows=data.answers.map(function(a){return [a.answer,a.responses,a.places];});
  function safe(value){var s=String(value);if(/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
  var blob=new Blob(['\uFEFF'+[headers].concat(rows).map(function(row){return row.map(safe).join(',');}).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a',{attrs:{href:url,download:'sahra-form-summary.csv'}});document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
 function draw(){if(!root||!root.isConnected)return;Sahra.clear(root);var box=el('section',{class:'s-card fi-card'});root.appendChild(box);box.append(el('h2',{text:t('fi_title')}),el('p',{class:'muted',text:t('fi_intro')}));
  if(!data&&loading){box.appendChild(el('p',{text:t('loading')}));return;}
  if(error){box.append(el('p',{class:'notice no',text:error}),el('button',{class:'btn',text:t('sh_refresh'),attrs:{type:'button'},on:{click:load}}));if(!data)return;}
  if(!data)return;
  if(!data.questions.length){box.append(el('p',{text:t('fi_no_questions')}),el('a',{class:'btn',text:t('s_form'),attrs:{href:'/party.html#form'}}));return;}
  var question=S.select('insight_question',data.questions.map(function(q){return [q.id,q.label];}),state.question),scope=S.select('insight_scope',[['approved',t('q_approved')],['pending',t('q_waiting')],['all',t('bf_all_records')]],state.scope);
  question.addEventListener('change',function(){change({question:question.value});});scope.addEventListener('change',function(){change({scope:scope.value});});
  box.appendChild(el('div',{class:'fi-controls'},S.field(t('fi_question'),question),S.field(t('bf_status'),scope)));
  box.appendChild(SahraBooking.dates(state,function(v){change({date_from:v.date_from,date_to:v.date_to});}));
  var compare=S.input('insight_cutoff','number',{step:'any',min:-1e12,max:1e12,required:true,value:draft});compare.addEventListener('input',function(){draft=compare.value;});
  var form=el('form',{class:'fi-compare'},S.field(t('fi_compare'),compare),el('button',{class:'btn primary',text:t('fi_update'),attrs:{type:'submit',disabled:loading}}));form.addEventListener('submit',function(e){e.preventDefault();if(!form.reportValidity())return;change({cutoff:compare.value});});box.appendChild(form);
  if(loading){box.appendChild(el('p',{attrs:{role:'status'},text:t('loading')}));return;}
  if(error)return;
  var s=data.summary,answered=Number(s.answered),numeric=Number(s.numeric_answers),missing=Number(s.tickets)-answered;
  box.appendChild(el('div',{class:'fi-metrics'},metric(t('fi_tickets'),s.tickets),metric(t('fi_responses'),answered),metric(t('fi_missing'),missing),metric(t('fi_places'),s.places)));
  box.appendChild(el('p',{class:'small muted',text:t('fi_group_hint')}));
  box.append(el('h3',{text:t('fi_numeric')}),el('div',{class:'fi-metrics fi-comparison'},metric(t('fi_below',{n:number(data.cutoff)}),s.below),metric(t('fi_equal',{n:number(data.cutoff)}),s.equal),metric(t('fi_above',{n:number(data.cutoff)}),s.above)));
  box.appendChild(el('p',{class:'small muted',text:t('fi_numeric_hint',{n:numeric,invalid:answered-numeric})}));
  if(numeric)box.appendChild(el('p',{class:'small muted',text:t('fi_range',{min:number(s.minimum),max:number(s.maximum),average:number(s.average)})}));
  var head=el('div',{class:'fi-table-head'},el('h3',{text:t('fi_distribution')}));head.appendChild(el('button',{class:'btn small-btn',text:t('fi_csv'),attrs:{type:'button',disabled:!data.answers.length},on:{click:csv}}));box.appendChild(head);
  if(!data.answers.length){box.appendChild(el('p',{text:t('fi_empty')}));return;}
  if(data.truncated)box.appendChild(el('p',{class:'small muted',text:t('fi_top50')}));
  var table=el('table',{class:'fi-table'},el('caption',{class:'sr-only',text:t('fi_distribution')}),el('thead',null,el('tr',null,cell(t('fi_answer'),true),cell(t('fi_responses'),true),cell(t('fi_places'),true))));
  table.appendChild(el('tbody',null,data.answers.map(function(a){var label=cell(a.answer),bar=el('span',{class:'fi-bar',attrs:{'aria-hidden':'true'}});bar.style.width=(100*Number(a.responses)/Math.max(1,answered))+'%';label.appendChild(bar);return el('tr',null,label,cell(a.responses),cell(a.places));})));box.appendChild(table);

 }
 return {mount:function(node,id){root=node;if(partyId&&partyId!==id){data=null;state.question='';}partyId=id;draw();if(!data&&!loading)load();},refresh:function(){if(root&&root.isConnected&&!loading)load();}};
})();

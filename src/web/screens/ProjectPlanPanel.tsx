import {useEffect,useState} from 'react';
import {useAsync} from '../lib/useAsync';
import {api} from '../lib/api';
import {useI18n} from '../lib/i18n';
import {usePrivacy} from '../lib/privacy';
import { TableRow,Card,CardTitle,Selector,Table,Th,Td,ErrorState,HelpBlock,HelpDot,LoadingCard} from '../components/ui';
const value=(n:number|null,suffix='')=>n===null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2})+suffix;
function missingReason(reason:string,t:(en:string,pl:string)=>string):string {
  const messages:Record<string,[string,string]>={valuation_missing:['Some traffic has no Standard price','Część ruchu nie ma ceny Standard'],valuation_preparing:['Valuation is being prepared','Przygotowywanie wyceny'],
    price_missing:['No dated plan price','Brak datowanej ceny planu'],plan_version_missing:['No plan version for this date','Brak wersji planu na tę datę'],base_version_mismatch:['The measurement belongs to another plan version','Pomiar dotyczy innej wersji planu'],
    multiplier_missing:['No official multiplier','Brak oficjalnego mnożnika'],no_vendor_traffic:['No traffic for this vendor','Brak ruchu tego dostawcy'],attribution_missing:['Some traffic has no dated account attribution','Część ruchu nie ma datowanego przypisania do konta']};
  return messages[reason]?t(...messages[reason]):t('No compatible capacity measurement','Brak zgodnego pomiaru pojemności');
}
export function ProjectPlanPanel({initialProject=''}:{initialProject?:string}={}){
  const {t}=useI18n(),[project,setProject]=useState(initialProject),[plans,setPlans]=useState<string[]>([]),[mode,setMode]=useState('historical');
  const hidden=usePrivacy();
  const state=useAsync(signal=>api.projectPlan(project||undefined,plans,signal),[project,plans.join(',')]);
  useEffect(()=>{if(!state.data?.preparing&&!state.data?.stale)return;const timer=setTimeout(state.reload,3000);return()=>clearTimeout(timer)},[state.data,state.reload]);
  if(!state.data)return state.error?<ErrorState message={state.error} onRetry={state.reload}/>:<LoadingCard label={t('Preparing project choices','Przygotowywanie projektów')}/>;
  const data=state.data;
  return <Card><CardTitle title={t('Project on a chosen plan','Projekt na wybranym planie')} right={<HelpDot label={t('About project estimates','O szacunkach projektu')}>
    <HelpBlock>{t('Standard API equivalent; each vendor uses only its own traffic','Ekwiwalent Standard API; każdy dostawca uwzględnia tylko własny ruch')}</HelpBlock>
    <HelpBlock>{t('Historical: each weekly slice uses its own capacity and dated price. Today: all original traffic is valued at one current price list and current capacity. Whole months use the price of the last project week in historical mode, or the shown date in Today mode. Codex retains Standard normalization for Speed. Estimates are conditional on the indexed sources and model mix.','Historycznie: każda tygodniowa część używa swojej pojemności i datowanej ceny. Dzisiaj: cały oryginalny ruch jest wyceniony przy jednym bieżącym cenniku i pojemności. Pełne miesiące używają ceny ostatniego tygodnia projektu w trybie historycznym lub pokazanej daty w trybie Dzisiaj. Codex zachowuje normalizację Standard dla Speed. Szacunki są warunkowe względem zaindeksowanych źródeł i miksu modeli.')}</HelpBlock>
  </HelpDot>}/>
    <div className="rate-controls"><Selector label={t('Project','Projekt')} value={project} onChange={p=>{setProject(p);setPlans([])}} options={[{value:'',label:t('Choose a project','Wybierz projekt')},...data.projects.map((p,i)=>({value:p,label:hidden?t('Project','Projekt')+' '+(i+1):p.slice(2)}))]}/>
      <Selector label={t('Valuation','Wycena')} value={mode} onChange={setMode} options={[{value:'historical',label:t('Historical','Historyczna')},{value:'today',label:t('Today','Dzisiaj')}]}/></div>
    <div className="rate-plan-choices" role="group" aria-label={t('Plans to compare','Plany do porównania')}>{data.plans.map(p=><label key={p.id}><input type="checkbox" checked={plans.includes(p.id)} onChange={e=>setPlans(old=>e.target.checked?[...old,p.id]:old.filter(id=>id!==p.id))}/>{p.provider} · {p.label}</label>)}</div>
    {(data.preparing||data.stale)&&<p role="status">{t('Project facts are being prepared in the background.','Fakty projektu są przygotowywane w tle.')}</p>}
    <Table tableId="ProjectPlanPanel:0"><thead><TableRow header><Th columnId="c0">{t('Plan','Plan')}</Th><Th columnId="c1">{t('API work','Praca według API')}</Th><Th columnId="c2">{t('Weeks / 100%','Tygodnie / 100%')}</Th><Th columnId="c3">{t('Months','Miesiące')}</Th><Th columnId="c4">{t('Pro-rata cost','Koszt proporcjonalny')}</Th><Th columnId="c5">{t('Whole months','Pełne miesiące')}</Th><Th columnId="c6">{t('5h sessions','Sesje 5h')}</Th><Th columnId="c7">{t('Evidence','Podstawa')}</Th></TableRow></thead>
    <tbody>{data.rows.filter(r=>r.mode===mode).map(r=><TableRow key={r.plan_id}><Td>{r.estimate?'≈ ':''}{r.provider} · {r.label}</Td><Td mono>{value(r.api_usd,' USD')}</Td><Td mono>{value(r.weeks)}</Td><Td mono>{value(r.months)}</Td><Td mono>{value(r.pro_rata,' USD')}</Td><Td mono>{value(r.whole_months,' USD')}</Td><Td mono>{value(r.sessions)}</Td><Td>{r.absent?missingReason(r.absent,t):r.estimate?t('Estimate from the catalog multiplier','Szacunek według mnożnika katalogowego'):t('Shared measurement','Wspólny pomiar')}
      {r.preliminary?' · '+t('preliminary','wstępne'):''} · {r.reference_date}
      {r.session_absent&&<div>{t('5h capacity unavailable','Brak pojemności 5h')}</div>}
      {r.five_hour_limited&&<div>{t('The busiest 5h period would reach the session limit before the weekly limit.','Najbardziej obciążone 5h osiągnęłyby limit sesji wcześniej niż limit tygodniowy.')}</div>}</Td></TableRow>)}</tbody></Table>
  </Card>;
}

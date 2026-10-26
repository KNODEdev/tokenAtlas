import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useI18n} from '../lib/i18n';
import {usePrivacy} from '../lib/privacy';
import {comparisonList,type ComparisonEntry} from '../lib/comparison-list';
import {encodeComparisonCode,comparisonMatches,isoWeek,PUBLIC_COMPARISON_PLANS,ComparisonCodeError} from '../../shared/comparison-code';
import type {RateWindow} from '../../shared/subscription-rate';
import {renderCardPng,downloadPng} from '../components/card-png';
import {Brand} from '../components/Sidebar';
import { TableRow,Card,CardTitle,Selector,GhostButton,HelpBlock,HelpDot,Table,Th,Td} from '../components/ui';

const number=(n:number|null,suffix='')=>n===null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2})+suffix;
const why=(error:unknown,t:(en:string,pl:string)=>string)=>error instanceof ComparisonCodeError?
  error.reason==='newer_version'?t('This code needs a newer format version.','Ten kod wymaga nowszej wersji formatu.'):
  error.reason==='integrity'?t('The code was edited or damaged.','Kod został zmieniony lub uszkodzony.'):
  error.reason==='unsupported_plan'?t('This code does not name a supported public plan.','Kod nie wskazuje obsługiwanego publicznego planu.'):
  error.reason==='measurement_unavailable'?t('Choose a closed window with a rate measurement.','Wybierz zamknięte okno z pomiarem kursu.'):
  t('The code has an invalid format or fields.','Kod ma niepoprawny format lub pola.'):
  t('The local operation failed. Check browser clipboard and storage access.','Operacja lokalna nie powiodła się. Sprawdź dostęp przeglądarki do schowka i pamięci.');
export function RateSharePanel({windows}:{windows:readonly RateWindow[]}){
  const {t}=useI18n(),hidden=usePrivacy(),[selected,setSelected]=useState(''),[encoded,setEncoded]=useState<{key:string;code:string}|null>(null),
    [entries,setEntries]=useState<ComparisonEntry[]>([]),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const card=useRef<HTMLDivElement>(null);
  const eligible=windows.filter(w=>w.closed&&w.rate!==null&&w.plan_id&&PUBLIC_COMPARISON_PLANS.has(w.plan_id));
  const window=eligible.find(w=>w.id===selected)??eligible.at(-1);
  const key=window?JSON.stringify([window.id,window.value_100_usd,window.api_usd,window.used_pp,window.rate,window.hours_per_100,window.price_date,window.mix,window.preliminary]):'';
  const currentKey=useRef(key);
  useLayoutEffect(()=>{currentKey.current=key},[key]);
  const code=encoded?.key===key?encoded.code:null;
  useEffect(()=>{
    let cancelled=false;
    if(window)encodeComparisonCode(window).then(value=>{if(!cancelled)setEncoded({key,code:value})}).catch(e=>{if(!cancelled)setError(why(e,t))});
    return()=>{cancelled=true};
  },[window,key,t]);
  useEffect(()=>{let cancelled=false;comparisonList(localStorage).read().then(values=>{if(!cancelled)setEntries(values)}).catch(e=>{if(!cancelled)setError(why(e,t))});return()=>{cancelled=true}},[t]);
  const capture=async(copy:boolean)=>{
    if(!card.current||!code)return;
    const source=key;setBusy(true);setError('');setNotice('');
    try{
      const blob=await renderCardPng(card.current);
      if(currentKey.current!==source)throw new Error('selection_changed');
      if(copy)await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
      else downloadPng(blob,'tokenatlas-'+isoWeek(window!.start)+'.png');
      setNotice(copy?t('PNG copied','Skopiowano PNG'):t('PNG saved','Zapisano PNG'));
    }catch(e){setError(why(e,t))}finally{setBusy(false)}
  };
  const copyCode=async()=>{if(!code)return;try{await navigator.clipboard.writeText(code);setNotice(t('Code copied','Skopiowano kod'))}catch(e){setError(why(e,t))}};
  const add=async()=>{setBusy(true);setError('');try{setEntries(await comparisonList(localStorage).add(text));setText('')}catch(e){setError(why(e,t))}finally{setBusy(false)}};
  const remove=async(code:string)=>{try{setEntries(await comparisonList(localStorage).remove(code))}catch(e){setError(why(e,t))}};
  return <Card><CardTitle title={t('Share a weekly measurement','Udostępnij pomiar tygodniowy')} right={<HelpDot label={t('About sharing','O udostępnianiu')}>
    <HelpBlock>{t('Local PNG and rounded comparison codes','Lokalny PNG i zaokrąglone kody porównawcze')}</HelpBlock>
    <HelpBlock>{t('Codes contain rounded public measurement fields only. The integrity check detects damaged edits and does not certify the measurement. This list stays in this browser; nothing is uploaded automatically.','Kody zawierają tylko zaokrąglone publiczne pola pomiaru. Kontrola integralności wykrywa uszkodzone zmiany i nie poświadcza pomiaru. Lista pozostaje w tej przeglądarce; nic nie jest automatycznie wysyłane.')}</HelpBlock>
  </HelpDot>}/>
    <div className="rate-controls"><Selector label={t('Week to share','Tydzień do udostępnienia')} value={window?.id??''} onChange={setSelected} options={eligible.map((w,i)=>({value:w.id,label:(hidden?t('Subscription','Abonament')+' '+(i+1):w.account)+' · '+isoWeek(w.start)+' · '+PUBLIC_COMPARISON_PLANS.get(w.plan_id!)!.label}))}/>
      <GhostButton disabled={busy||!code} onClick={()=>void capture(true)}>{t('Copy PNG','Kopiuj PNG')}</GhostButton>
      <GhostButton disabled={busy||!code} onClick={()=>void capture(false)}>{t('Save PNG','Zapisz PNG')}</GhostButton>
      <GhostButton disabled={busy||!code} onClick={()=>void copyCode()}>{t('Copy code','Kopiuj kod')}</GhostButton></div>
    {window?<RateMeasurementCard window={window} code={code} nodeRef={card}/>:<p>{t('There are no closed windows with a shareable rate yet.','Brak zamkniętych okien z kursem do udostępnienia.')}</p>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
    <div className="rate-controls"><label className="rate-code-input">{t('Paste a comparison code','Wklej kod porównawczy')}<textarea value={text} onChange={e=>setText(e.target.value)} spellCheck={false} rows={2}/></label>
      <GhostButton disabled={busy||!text.trim()} onClick={()=>void add()}>{t('Add local comparison','Dodaj lokalne porównanie')}</GhostButton></div>
    <Table tableId="RateSharePanel:0"><thead><TableRow header><Th columnId="c0">{t('Plan / week','Plan / tydzień')}</Th><Th columnId="c1">{t('Pasted rate','Wklejony kurs')}</Th><Th columnId="c2">{t('Your rate','Twój kurs')}</Th><Th columnId="c3">{t('Hours / 100%','Godziny / 100%')}</Th><Th columnId="c4">{t('Quality','Jakość')}</Th><Th columnId="c5">{t('Local entry','Wpis lokalny')}</Th></TableRow></thead>
      <tbody>{entries.map(entry=>{const p=entry.payload,own=windows.filter(w=>comparisonMatches(p,w)).at(-1);return <TableRow key={entry.code}><Td>{p.vendor} · {PUBLIC_COMPARISON_PLANS.get(p.plan)!.label} · {p.week}</Td><Td mono>≈ {number(p.rate,'×')}</Td><Td mono>{number(own?.rate??null,'×')}</Td><Td mono>≈ {number(p.hours,' h')}</Td><Td>{p.quality==='measured'?t('Unverified measurement','Pomiar niezweryfikowany'):p.quality==='conditional'?t('Conditional','Warunkowy'):t('Preliminary','Wstępny')}</Td><Td><GhostButton onClick={()=>void remove(entry.code)}>{t('Remove comparison','Usuń porównanie')}</GhostButton></Td></TableRow>})}</tbody></Table>
  </Card>;
}

export function RateMeasurementCard({window,code,nodeRef}:{window:RateWindow;code:string|null;nodeRef?:React.RefObject<HTMLDivElement|null>}){
  const {t}=useI18n();
  return <div className="rate-share-card" ref={nodeRef}>
      <div className="rate-share-header"><Brand/><strong>{window.provider} · {PUBLIC_COMPARISON_PLANS.get(window.plan_id!)!.label} · {isoWeek(window.start)}</strong></div>
      <div className="rate-share-values">
        <div><span>{t('Subscription rate','Kurs abonamentu')}</span><strong>{number(window.rate,'×')}</strong></div>
        <div><span>{t('API work this week','Praca według API w tygodniu')}</span><strong>{number(window.api_usd,' USD')}</strong></div>
        <div><span>{t('Limit reading','Odczyt limitu')}</span><strong>{number(window.used_pp,' p.p.')}</strong></div>
        <div><span>{t('Hours / 100%','Godziny / 100%')}</span><strong>{number(window.hours_per_100,' h')}</strong></div>
      </div>
      <p>{t('Price date','Data cennika')}: {window.price_date} · {window.preliminary?t('Preliminary measurement','Pomiar wstępny'):window.provider==='claude'?t('Conditional Code-share estimate','Warunkowy szacunek z udziału Code'):t('Shared native calibration','Wspólna kalibracja natywna')}</p>
      <p className="rate-share-code">{code??t('Preparing code…','Przygotowywanie kodu…')}</p>
      <p className="rate-note">{t('Conditional on indexed traffic and model mix. Active time sums request gaps up to 5 minutes inclusive. A lower rate alone does not prove a smaller allowance.','Wynik warunkowy względem zaindeksowanego ruchu i miksu modeli. Czas aktywny sumuje przerwy między żądaniami do 5 minut włącznie. Sam niższy kurs nie dowodzi zmniejszenia limitu.')}</p>
    </div>;
}

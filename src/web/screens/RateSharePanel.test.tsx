import {test,expect} from 'bun:test';
import fs from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {RateMeasurementCard} from './RateSharePanel';
import {shareFixture} from '../../shared/comparison-code.fixture';
import {encodeComparisonCode} from '../../shared/comparison-code';
test('the PNG card has all requested fields and no identifying source metadata',async()=>{
  const code=await encodeComparisonCode(shareFixture),html=renderToStaticMarkup(<RateMeasurementCard window={shareFixture} code={code}/>);
  expect(html).toContain('rate-share-card');expect(html).toContain('2026-W40');expect(html).toContain('TA1-');expect(html).toContain('2026-10-04');
  for(const forbidden of ['person@example.com','secret-subscription-week','private name','private-version','private-subscription','C:/secret/customer/file','2026-10-04T11:00'])expect(html).not.toContain(forbidden);
});
test('drawer and rate card use the shared image renderer; the renderer loads only its inline SVG',()=>{
  const drawer=['../components/ProjectDrawer.tsx','../components/project-drawer/presentation.tsx','../components/project-drawer/ProjectMixChart.tsx','../components/project-drawer/ProjectTimeChart.tsx'].map(path=>fs.readFileSync(new URL(path,import.meta.url),'utf8')).join('\n'),share=fs.readFileSync(new URL('./RateSharePanel.tsx',import.meta.url),'utf8');
  expect(drawer).toContain('from "../ChartExport"');expect(share).toContain("from '../components/card-png'");
  const controls=fs.readFileSync(new URL('../components/ChartExport.tsx',import.meta.url),'utf8');
  expect(controls).toContain('from "./card-png"');
  const renderer=fs.readFileSync(new URL('../components/card-png.ts',import.meta.url),'utf8');
  expect(renderer).toContain('data:image/svg+xml');expect(renderer).not.toContain('fetch(');expect(renderer).not.toContain('https://');
  expect(drawer).not.toContain('canvas.toBlob');expect(share).not.toContain('canvas.toBlob');
});

import type {RateWindow} from "./subscription-rate";
export const shareFixture:RateWindow={id:'secret-subscription-week',provider:'claude',account:'person@example.com',
  start:'2026-10-04T11:00:00.214Z',end:'2026-10-08T10:34:16.121Z',closed:true,plan:'private name',plan_id:'claude-max-20x',plan_version:'private-version',
  price_usd:200,price_date:'2026-10-04',rule_from:'2026-09-24T09:55:57.164Z',cycles:3,preliminary:false,
  capacity:{sub_id:'private-subscription',vendor:'claude',plan:'private-plan',usd_per_month:200,usd_per_point:12.334,weekly_window_value_usd:1233.4,
    session_window_value_usd:null,window_hours:168,session_hours:null,capacity_basis:'measured',price_basis:'rate-card',cadence:'probe',
    calibration_start_ts:'2026-10-04T11:00:00.214Z',calibration_end_ts:'2026-10-08T10:34:16.121Z'},
  value_100_usd:1233.4,rate:26.81521,absent:null,used_pp:64.3,api_usd:456.789,fixed_api_usd:null,fixed_date:null,
  common_historical_usd:null,common_fixed_usd:null,comparison:null,active_hours:12.45,hours_per_100:32.88,hours_absent:null,
  mix:[{model:'claude-sonnet-5-5',share:0.34},{model:'C:/secret/customer/file',share:0.66}],scope:'conditional',computed_at:'2026-10-13T11:30:45.123Z'};

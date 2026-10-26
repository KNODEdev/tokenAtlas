/** The preparation receipt a client polls (X-Analysis: preparing). */
export const preparingRows=()=>Response.json({status:"preparing",error:"Dane są przygotowywane w tle."},
  {status:202,headers:{"X-Analysis":"preparing","X-Analysis-Poll-Ms":"100","Cache-Control":"no-store"}});

export const preparingDataResponse = () => preparingRows();

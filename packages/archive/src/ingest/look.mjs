import { z } from 'zod';

export const documentSchema=z.object({what_it_is:z.string(),text:z.string(),fields:z.array(z.object({label:z.string(),value:z.string()}).strict()),language:z.string(),confidence:z.number().min(0).max(1)}).strict();
export const judgeSchema=z.object({pass:z.boolean(),reasons:z.array(z.string())}).strict();
export const EXTRACT_PROMPT=`You are reading one or more photographed or scanned pages that belong to a person's private archive (identity documents, insurance, bills, letters, receipts, notes). Return ONLY a JSON object with these keys:
- what_it_is: one or two sentences describing the document or image.
- text: every legible piece of text, in reading order, line breaks kept, exactly as printed (do not translate, do not correct, do not guess unreadable characters; use [illegible] for unreadable spans).
- fields: an array of {label, value} for structured facts a person would search for: document type, holder or issuer, document or policy or reference number, dates (issue, expiry, due), amounts with currency, IBAN or account references, addresses. Labels in English, values verbatim. Format dates as YYYY-MM-DD when the day, month and year are all legible; otherwise verbatim.
- language: ISO 639-1 code of the dominant text language.
- confidence: 0 to 1, how legible the material was overall.
Do not add keys. Do not add commentary. If the image contains no text, text is an empty string and fields is an empty array.`;
export function parseJson(text){const raw=String(text).trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');return JSON.parse(raw);}
export function createLook({invoke,defaultTarget='cc-sonnet'}) {
  return async function look({imagePaths,prompt,schema=documentSchema,target=defaultTarget,timeoutMs=120_000,beforeRetry=async()=>{}}) {
    const start=performance.now();let error;const usage={inputTokens:0,outputTokens:0};
    for(let attempt=0;attempt<2;attempt++){
      if(attempt)await beforeRetry();
      const result=await invoke({imagePaths,prompt:attempt?`${prompt}\nYour prior JSON failed validation: ${error}. Return corrected JSON only.`:prompt,target,timeoutMs});
      for(const [key,value] of Object.entries(result.usage??{}))if(typeof value==='number')usage[key]=(usage[key]??0)+value;
      try{return {json:schema.parse(typeof result.json==='object'?result.json:parseJson(result.text)),target:result.target??target,model:result.model,usage,ms:Math.round(performance.now()-start)};}catch(e){error=e.message;if(attempt)throw new Error('Extraction returned invalid JSON: '+error);}
    }
  };
}
export async function look(options){if(!options.invoke)throw new Error('look requires the shell runtime binding');return createLook({invoke:options.invoke})(options);}

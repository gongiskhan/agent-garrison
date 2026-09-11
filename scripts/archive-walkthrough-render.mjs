#!/usr/bin/env node
// Render only the fixture walkthrough's explicit narration and recorded video.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: archive-walkthrough-render.mjs <test artifact directory> <output directory>');
const manifest=JSON.parse(await fs.readFile(path.join(input,'narration.json'),'utf8'));
if(!manifest.fixtureOnly||manifest.expandedSensitiveRecorded!==false)throw new Error('Only safe fixture recordings may be rendered');
const video=path.join(input,'video.webm');await fs.access(video);await fs.mkdir(output,{recursive:true});
const execute=(args)=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{maxBuffer:1024*1024});
const duration=file=>Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{encoding:'utf8'}).trim());
const span=(manifest.endedAt-manifest.startedAt)/1000,videoLength=duration(video),offset=Math.max(0,videoLength-span);
let voiceEnd=0;const clips=[];
for(let i=0;i<manifest.beats.length;i++){
 const beat=manifest.beats[i],text=path.resolve(output,`narration-${i}.txt`),wav=path.resolve(output,`narration-${i}.wav`);await fs.writeFile(text,beat.text);
 // Paths are passed directly as argv; no shell or command substitution.
 const escaped=text.replaceAll('\\','\\\\').replaceAll(':','\\:').replaceAll("'","\\'");
 execute(['-f','lavfi','-i',`flite=textfile='${escaped}':voice=slt`,'-ar','48000',wav]);
 const at=Math.max(beat.at,voiceEnd+0.15);voiceEnd=at+duration(wav);clips.push({wav,at,text:beat.text});
}
const audio=path.resolve(output,'narration.wav'),mix=clips.map((c,i)=>`[${i}:a]adelay=${Math.round(c.at*1000)}:all=1[a${i}]`).join(';')+';'+clips.map((_,i)=>`[a${i}]`).join('')+`amix=inputs=${clips.length}:normalize=0[out]`;
execute([...clips.flatMap(c=>['-i',c.wav]),'-filter_complex',mix,'-map','[out]',audio]);
execute(['-ss',String(offset),'-i',video,'-i',audio,'-vf',`tpad=stop_mode=clone:stop_duration=${Math.max(0,voiceEnd-span)+1},pad=ceil(iw/2)*2:ceil(ih/2)*2`,'-t',String(Math.max(span,voiceEnd)+0.5),'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',path.resolve(output,'final.mp4')]);
await fs.writeFile(path.join(output,'render.json'),JSON.stringify({...manifest,renderedBeats:clips.map(({at,text})=>({at,text})),videoTrimSeconds:offset},null,2));
console.log(JSON.stringify({video:path.resolve(output,'final.mp4'),seconds:duration(path.resolve(output,'final.mp4')),beats:clips.length,fixtureOnly:true}));

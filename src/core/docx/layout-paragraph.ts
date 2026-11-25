import { xmlAttributes } from './outline.js';
import { editableText, visibleOffsetBefore } from './visible-surgery.js';
import { xmlElements } from './xml.js';

/** Effective paragraph geometry includes document defaults and per-attribute style inheritance. */
export function paragraphLayout(xml:string,stylesXml:string) {
  const nodes=xmlElements(xml),styles=xmlElements(stylesXml);
  const child=(list:typeof nodes,parent:number,name:string)=>list.findIndex(node=>node.parent===parent&&node.name===name);
  const attrs=(source:string,list:typeof nodes,index:number)=>index<0?new Map<string,string>():xmlAttributes(source,list[index]);
  const properties=(index:number,name:string)=>{
    const result=new Map<string,string>(),merge=(source:string,list:typeof nodes,parent:number)=>{for(const [key,value]of attrs(source,list,child(list,parent,name)))result.set(key,value);};
    const defaults=styles.findIndex(node=>node.name==='w:pPrDefault');merge(stylesXml,styles,child(styles,defaults,'w:pPr'));
    const pPr=child(nodes,index,'w:pPr'),id=attrs(xml,nodes,child(nodes,pPr,'w:pStyle')).get('w:val');
    const seen=new Set<number>(),chain:number[]=[];
    const visit=(style:number)=>{if(style<0||seen.has(style))return;seen.add(style);const based=attrs(stylesXml,styles,child(styles,style,'w:basedOn')).get('w:val');if(based)visit(styles.findIndex((node,i)=>node.name==='w:style'&&attrs(stylesXml,styles,i).get('w:styleId')===based));chain.push(style);};
    visit(styles.findIndex((node,i)=>node.name==='w:style'&&attrs(stylesXml,styles,i).get('w:type')==='paragraph'&&['1','true','on'].includes(attrs(stylesXml,styles,i).get('w:default')??'')));
    if(id)visit(styles.findIndex((node,i)=>node.name==='w:style'&&attrs(stylesXml,styles,i).get('w:styleId')===id));
    for(const style of chain)merge(stylesXml,styles,child(styles,style,'w:pPr'));merge(xml,nodes,pPr);
    return {result,chain,pPr};
  };
  const font=(index:number)=>{
    const {chain,pPr}=properties(index,'w:ind'),values:number[]=[];
    const add=(source:string,list:typeof nodes,parent:number)=>{const value=Number(attrs(source,list,child(list,parent,'w:sz')).get('w:val'));if(value>0)values.push(value*10);};
    const defaults=styles.findIndex(node=>node.name==='w:rPrDefault');add(stylesXml,styles,child(styles,defaults,'w:rPr'));
    for(const style of chain)add(stylesXml,styles,child(styles,style,'w:rPr'));add(xml,nodes,child(nodes,pPr,'w:rPr'));
    for(const [i,node]of nodes.entries())if(node.name==='w:rPr'&&node.start>=nodes[index].start&&node.end<=nodes[index].end)add(xml,nodes,i);
    return values.length?Math.max(...values):220;
  };
  const insets=(index:number)=>{
    const {result:ind}=properties(index,'w:ind'),size=font(index);
    const value=(twips:string[],chars:string[])=>Math.max(0,...twips.map(key=>Number(ind.get(`w:${key}`)??0)),...chars.map(key=>Number(ind.get(`w:${key}`)??0)*size/100));
    const left=value(['left','start'],['leftChars','startChars']),right=value(['right','end'],['rightChars','endChars']);
    const first=value(['firstLine'],['firstLineChars']),hanging=value(['hanging'],['hangingChars']);
    return {left:left+first,right,outside:left+first-hanging<0};
  };
  const spacing=(index:number)=>properties(index,'w:spacing').result;
  const measure=(index:number,width:number)=>{
    const text=editableText(xml.slice(nodes[index].start,nodes[index].end)),size=font(index),ind=insets(index),space=spacing(index);
    const line=Number(space.get('w:line')??240),rule=space.get('w:lineRule');
    const pitch=rule==='exact'?line:rule==='atLeast'?Math.max(line,size*1.2):Math.max(size*1.2,size*1.2*line/240);
    const lines=text.split('\n').reduce((sum,value)=>sum+(value.length?Math.max(1,Math.ceil(Array.from(value).length*size/Math.max(1,width-ind.left-ind.right))):0),0);
    const drawings=nodes.flatMap((node,i)=>node.name==='w:drawing'&&node.start>=nodes[index].start&&node.end<=nodes[index].end?[i]:[]);
    const seal=(drawing:number)=>nodes.some((node,i)=>node.name==='wp:docPr'&&node.start>=nodes[drawing].start&&node.end<=nodes[drawing].end&&/^Seal image \d+$/.test(attrs(xml,nodes,i).get('name')??''));
    const nativeHeight=drawings.filter(i=>!seal(i)).reduce((sum,drawing)=>{const extent=nodes.findIndex(node=>node.name==='wp:extent'&&node.start>=nodes[drawing].start&&node.end<=nodes[drawing].end);return sum+Number(attrs(xml,nodes,extent).get('cy')??0)/635;},0);
    const body=drawings.length?lines*pitch+nativeHeight+120:Math.max(1,lines)*pitch;
    return {height:body+Math.max(0,Number(space.get('w:before')??0))+Math.max(0,Number(space.get('w:after')??0)),images:drawings.filter(seal)};
  };
  const prefix=(index:number,position:number)=>{
    const paragraph=xml.slice(nodes[index].start,nodes[index].end);
    const text=editableText(paragraph).slice(0,visibleOffsetBefore(paragraph,position-nodes[index].start));
    return Array.from(text.split('\n').at(-1)?.replace(/\t/g,'    ')??'').length*font(index);
  };
  return {insets,spacing,measure,prefix};
}

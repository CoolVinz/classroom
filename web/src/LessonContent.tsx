import { useState } from "react";

export type LessonBlock =
  | { type: "text"; heading?: string; text: string }
  | { type: "image"; imageId: string; alt: string; caption?: string }
  | { type: "youtube"; videoId: string; caption?: string };

export function LessonContent({ title, blocks, imageUrl }: { title: string; blocks: LessonBlock[]; imageUrl: (id: string) => string }) {
  return <article className="lesson-reading-content"><h1>{title}</h1>{blocks.map((block, index) => block.type === "text"
    ? <section className="lesson-reading-text" key={index}>{block.heading && <h2>{block.heading}</h2>}<p>{block.text}</p></section>
    : block.type === "image"
      ? <figure key={block.imageId}><img loading="lazy" src={imageUrl(block.imageId)} alt={block.alt} />{block.caption && <figcaption>{block.caption}</figcaption>}</figure>
      : <YouTube key={block.videoId + "-" + index} block={block} />
  )}</article>;
}

function YouTube({ block }: { block: Extract<LessonBlock, { type: "youtube" }> }) {
  const [loaded, setLoaded] = useState(false);
  return <figure className="lesson-video">{loaded ? <iframe loading="lazy" title={block.caption || "บทเรียน YouTube"}
    src={`https://www.youtube-nocookie.com/embed/${block.videoId}?rel=0`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
    : <button className="lesson-video-load" onClick={() => setLoaded(true)}>▶ โหลดวิดีโอ</button>}
    <figcaption>{block.caption && <span>{block.caption} · </span>}<a href={`https://www.youtube.com/watch?v=${block.videoId}`} target="_blank" rel="noreferrer">เปิดบน YouTube ↗</a></figcaption></figure>;
}

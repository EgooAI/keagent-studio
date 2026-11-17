import { useState, type ReactNode } from "react";
import type { PanoramaScene } from "@keagent/shared-types";
import "./property-materials.css";

function MaterialThumbnail({ src, label }: { src?: string; label: string }) {
  const [failedSource, setFailedSource] = useState<string>();
  return (
    <li className="property-material-thumbnail">
      {src && src !== failedSource ? (
        <img
          src={src}
          alt={label}
          loading="lazy"
          onError={() => setFailedSource(src)}
        />
      ) : (
        <span role="img" aria-label={`${label}，预览不可用`}>
          预览不可用
        </span>
      )}
    </li>
  );
}

export function PropertyMaterialsTab({
  panoramas,
  references,
  actions,
  note,
  readFeedback,
}: {
  panoramas: (string | undefined)[];
  references: Pick<PanoramaScene, "id" | "url" | "room">[];
  actions: ReactNode;
  note?: ReactNode;
  readFeedback?: ReactNode;
}) {
  const showBoth = panoramas.length > 0 && references.length > 0;
  return (
    <section
      className="panel property-materials"
      aria-labelledby="materials-title"
    >
      <h2 id="materials-title">房源素材</h2>
      {readFeedback && (
        <div className="material-read-feedback">{readFeedback}</div>
      )}
      {(!readFeedback || panoramas.length > 0 || references.length > 0) && (
        <div
          className={`property-material-groups${showBoth ? " has-both" : ""}`}
        >
          <section aria-labelledby="panoramas-title">
            <h3 id="panoramas-title">{panoramas.length} 张 VR 全景图</h3>
            {panoramas.length > 0 && (
              <ul className="property-material-gallery">
                {panoramas.map((src, index) => (
                  <MaterialThumbnail
                    key={`${src}-${index}`}
                    src={src}
                    label={`房源图片 ${index + 1}`}
                  />
                ))}
              </ul>
            )}
          </section>
          {references.length > 0 && (
            <section
              className="property-material-references"
              aria-labelledby="references-title"
            >
              <h3 id="references-title">仅供文案参考的图片</h3>
              <ul className="property-material-gallery">
                {references.map((reference, index) => (
                  <MaterialThumbnail
                    key={reference.id}
                    src={reference.url}
                    label={reference.room || `房源参考图 ${index + 1}`}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {(note || actions) && (
        <footer className="property-material-footer">
          {note && <div className="property-material-note">{note}</div>}
          {actions && (
            <div className="property-material-actions">{actions}</div>
          )}
        </footer>
      )}
    </section>
  );
}

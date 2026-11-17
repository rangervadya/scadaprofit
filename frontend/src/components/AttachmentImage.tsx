import { useState } from 'react';

export function AttachmentImage({ src, name }: { src: string; name: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src) {
    return <span className="attachment-image-error">Изображение недоступно</span>;
  }

  return <img src={src} alt={name} loading="lazy" onError={() => setFailedSrc(src)} />;
}

interface FileUploadProps {
  onSelectFile: (image: File) => void;
  onDrop: (image: File) => void;
  uploadRef: React.RefObject<HTMLInputElement | null>;
}

export function FileUpload({ onSelectFile, onDrop, uploadRef }: FileUploadProps) {
  return (
    <div className="card upload-card" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const image = event.dataTransfer.files[0];
      if (image && /^image\/(jpeg|png|webp)$/.test(image.type)) onDrop(image);
    }}>
      <input
        ref={uploadRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(event) => {
          const image = event.currentTarget.files?.[0];
          if (image) onSelectFile(image);
          event.currentTarget.value = '';
        }}
      />
      <button onClick={() => uploadRef.current?.click()}>
        <span aria-hidden="true">⇧</span>Загрузить эскиз
        <small>или перетащите сюда</small>
      </button>
    </div>
  );
}

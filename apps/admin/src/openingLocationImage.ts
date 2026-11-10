export async function encodeOpeningLocation(file: File) {
  if (!/\.(jpe?g|png)$/i.test(file.name) || file.size > 15 * 1024 * 1024)
    throw new Error("请选择 15 MB 以内的 JPG 或 PNG 地点图");
  const image = await createImageBitmap(file).catch(() => {
    throw new Error("无法读取地点图片，请更换 JPG 或 PNG 文件");
  });
  try {
    const ratio = image.width / image.height;
    if (Math.min(image.width, image.height) < 256 || ratio < 0.4 || ratio > 2.5)
      throw new Error("地点图宽高均须至少 256 像素，宽高比须在 0.4–2.5 之间");
    const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法处理地点图片");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.65, 0.45]) {
      const encoded = canvas.toDataURL("image/jpeg", quality).split(",")[1];
      if (encoded && encoded.length <= 4 * Math.floor((512 * 1024) / 3))
        return encoded;
    }
    throw new Error("地点图压缩后仍超过 512 KB，请更换图片");
  } finally {
    image.close();
  }
}

export function openingImageURL(image: string) {
  return `data:image/${image.startsWith("iVBOR") ? "png" : "jpeg"};base64,${image}`;
}

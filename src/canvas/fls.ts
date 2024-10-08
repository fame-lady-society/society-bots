import { Image, CanvasRenderingContext2D, Canvas, loadImage } from "canvas";

async function createImageBitmap(imageBuffer: Buffer) {
  return loadImage(imageBuffer);
}

export async function resizeImage({
  imageBuffer,
  width,
  height,
}: {
  imageBuffer: Buffer;
  width: number;
  height: number;
}) {
  console.log("Creating image bitmap");
  const img = await createImageBitmap(imageBuffer);
  console.log("Creating canvas");
  const canvas: Canvas = new Canvas(width, height);
  console.log("Drawing image");
  const ctx: CanvasRenderingContext2D = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  console.log("Returning image");
  return canvas.toBuffer("image/png");
}

function calculateRowsAndColumns(numImages: number) {
  let numRows = Math.floor(Math.sqrt(numImages));
  let numCols = Math.ceil(numImages / numRows);

  while (numRows * numCols < numImages) {
    numRows += 1;
  }

  return { numRows, numCols };
}

export async function generateMosaic({ images }: { images: Image[] }) {
  const { numRows, numCols } = calculateRowsAndColumns(images.length);

  const imgWidth = images[0].width;
  const imgHeight = images[0].height;

  const mosaicWidth = numCols * imgWidth;
  const mosaicHeight = numRows * imgHeight;

  const maxCanvasSize = 2000;
  const widthScaleFactor = maxCanvasSize / mosaicWidth;
  const heightScaleFactor = maxCanvasSize / mosaicHeight;

  let scaleFactor = Math.min(widthScaleFactor, heightScaleFactor);

  const canvas = new Canvas(
    mosaicWidth * scaleFactor,
    mosaicHeight * scaleFactor
  );
  const ctx = canvas.getContext("2d");
  ctx.scale(scaleFactor, scaleFactor);

  for (let i = 0; i < numRows; i++) {
    for (let j = 0; j < numCols; j++) {
      const index = i * numCols + j;
      if (index < images.length) {
        ctx.drawImage(
          images[index],
          j * imgWidth,
          i * imgHeight,
          imgWidth,
          imgHeight
        );
      }
    }
  }

  return canvas;
}

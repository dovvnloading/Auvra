export interface TextureGenerationProvider {
  generateTexture(
    base64Image: string,
    userPrompt: string,
    maskReferenceBase64?: string
  ): Promise<string>;
}

const PROVIDER_NOT_CONFIGURED =
  'Texture generation provider is not configured. Add a media provider before generating textures.';

export class TextureGenerationService {
  constructor(private readonly provider?: TextureGenerationProvider) {}

  async generateTexture(
    base64Image: string,
    userPrompt: string,
    maskReferenceBase64?: string
  ): Promise<string> {
    if (!base64Image?.includes(',')) {
      throw new Error('Invalid image data provided.');
    }

    if (!userPrompt.trim()) {
      throw new Error('Describe the desired material before generating.');
    }

    if (!this.provider) {
      throw new Error(PROVIDER_NOT_CONFIGURED);
    }

    return this.provider.generateTexture(
      base64Image,
      userPrompt,
      maskReferenceBase64
    );
  }
}

export const textureService = new TextureGenerationService();

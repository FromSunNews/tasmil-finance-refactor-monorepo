import {
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Request } from "express";
import { Observable } from "rxjs";
import { ChatService } from "./chat.service";
import { CreateChatDto } from "./dto/chat.dto";
import { JwtAuthGuard } from "../auth/guards/auth.guard";
import { ChatSDKError } from "@repo/api";
import type { JwtPayload } from "../auth/auth.service";

@Controller("api/chat")
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private chatService: ChatService) {}

  @Post()
  @Sse()
  async createChat(
    @Body() dto: CreateChatDto,
    @Req() req: Request
  ): Promise<Observable<MessageEvent>> {
    const user = req.user as JwtPayload;

    if (!user) {
      throw new HttpException(
        new ChatSDKError("unauthorized:chat"),
        HttpStatus.UNAUTHORIZED
      );
    }

    // Extract geolocation from request headers if available
    // In production, you might get this from Vercel functions or request headers
    const requestHints = {
      latitude: null as number | null,
      longitude: null as number | null,
      city: null as string | null,
      country: null as string | null,
    };

    // Try to get from headers (Vercel provides these)
    const vercelGeo = req.headers["x-vercel-ip-country"];
    if (vercelGeo) {
      requestHints.country = vercelGeo as string;
    }

    try {
      return await this.chatService.createChatStream(
        {
          id: dto.id,
          message: dto.message as any,
          messages: dto.messages as any,
          selectedChatModel: dto.selectedChatModel,
          selectedVisibilityType: dto.selectedVisibilityType,
        },
        user,
        requestHints
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (
        error instanceof Error &&
        error.message?.includes(
          "AI Gateway requires a valid credit card on file to service requests"
        )
      ) {
        throw new HttpException(
          new ChatSDKError("bad_request:activate_gateway"),
          HttpStatus.BAD_REQUEST
        );
      }

      console.error("Unhandled error in chat API:", error);
      throw new HttpException(
        new ChatSDKError("offline:chat"),
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
  }

  @Get(":id")
  async getChat(
    @Param("id") id: string,
    @Req() req: Request
  ) {
    const user = req.user as JwtPayload;

    if (!user) {
      throw new HttpException(
        new ChatSDKError("unauthorized:chat"),
        HttpStatus.UNAUTHORIZED
      );
    }

    return this.chatService.getChatWithMessages(id, user.id);
  }

  @Get(":id/stream")
  @Sse()
  async getStream(
    @Param("id") id: string,
    @Req() req: Request
  ): Promise<Observable<string> | null> {
    const user = req.user as JwtPayload;

    if (!user) {
      throw new HttpException(
        new ChatSDKError("unauthorized:chat"),
        HttpStatus.UNAUTHORIZED
      );
    }

    const stream = await this.chatService.getResumableStream(id, user.id);
    return stream;
  }

  @Delete()
  async deleteChat(
    @Query("id") id: string,
    @Req() req: Request
  ) {
    const user = req.user as JwtPayload;

    if (!user) {
      throw new HttpException(
        new ChatSDKError("unauthorized:chat"),
        HttpStatus.UNAUTHORIZED
      );
    }

    if (!id) {
      throw new HttpException(
        new ChatSDKError("bad_request:api"),
        HttpStatus.BAD_REQUEST
      );
    }

    return this.chatService.deleteChat(id, user.id);
  }

  @Delete("messages/:id/trailing")
  async deleteTrailingMessages(
    @Param("id") messageId: string,
    @Req() req: Request
  ) {
    const user = req.user as JwtPayload;

    if (!user) {
      throw new HttpException(
        new ChatSDKError("unauthorized:chat"),
        HttpStatus.UNAUTHORIZED
      );
    }

    return this.chatService.deleteTrailingMessages(messageId, user.id);
  }

  @Patch(":id/visibility")
  async updateChatVisibility(
    @Param("id") chatId: string,
    @Body() body: { visibility: "private" | "public" },
    @Req() req: Request
  ) {
    const user = req.user as JwtPayload;

    if (!user) {
      throw new HttpException(
        new ChatSDKError("unauthorized:chat"),
        HttpStatus.UNAUTHORIZED
      );
    }

    return this.chatService.updateChatVisibility(chatId, body.visibility, user.id);
  }
}


import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TicketCategoriesController } from './ticket-categories.controller';
import { TicketCategoriesService } from './ticket-categories.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
    imports: [NotificationsModule],
    // `TicketCategoriesController` must stay first so `/tickets/categories` is
    // registered before the `:ticketId` route of `TicketsController`.
    controllers: [TicketCategoriesController, TicketsController],
    providers: [TicketsService, TicketCategoriesService],
    exports: [TicketsService, TicketCategoriesService],
})
export class TicketsModule {}

using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Enums;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class TaskValidator : ITaskValidator
{
    private readonly WebScrapeDbContext _db;

    public TaskValidator(WebScrapeDbContext db)
    {
        _db = db;
    }

    public async Task<List<ValidationErrorDto>> ValidateAsync(Guid userId, SaveTaskDto dto, CancellationToken ct = default)
    {
        var errors = new List<ValidationErrorDto>();

        if (string.IsNullOrWhiteSpace(dto.Name))
            errors.Add(new ValidationErrorDto { Code = ValidationCodes.MissingTaskName });

        // Pass 1: id uniqueness, parent-ref existence, type/payload shape.
        var byId = new Dictionary<Guid, TaskBlockTreeDto>();
        foreach (var block in dto.Blocks)
        {
            if (!byId.TryAdd(block.Id, block))
                errors.Add(new ValidationErrorDto { Code = ValidationCodes.DuplicateBlockId, BlockId = block.Id });
        }

        foreach (var block in dto.Blocks)
        {
            if (block.ParentBlockId.HasValue && !byId.ContainsKey(block.ParentBlockId.Value))
                errors.Add(new ValidationErrorDto { Code = ValidationCodes.InvalidParentReference, BlockId = block.Id });

            switch (block.BlockType)
            {
                case BlockType.Loop:
                    if (block.Loop is null)
                        errors.Add(new ValidationErrorDto { Code = ValidationCodes.InvalidBlockConfig, BlockId = block.Id, Message = "Loop block missing 'loop' payload" });
                    else if (string.IsNullOrWhiteSpace(block.Loop.Name))
                        errors.Add(new ValidationErrorDto { Code = ValidationCodes.MissingLoopName, BlockId = block.Id });
                    break;
                case BlockType.Scrape:
                    if (block.Scrape is null)
                        errors.Add(new ValidationErrorDto { Code = ValidationCodes.InvalidBlockConfig, BlockId = block.Id, Message = "Scrape block missing 'scrape' payload" });
                    else if (block.Scrape.ScraperConfigId == Guid.Empty)
                        errors.Add(new ValidationErrorDto { Code = ValidationCodes.InvalidBlockConfig, BlockId = block.Id, Message = "Scrape block missing scraperConfigId" });
                    break;
            }
        }

        // Pass 2: cycle detection. Walk parent chain from each block; detect re-visit.
        foreach (var block in dto.Blocks)
        {
            var seen = new HashSet<Guid> { block.Id };
            var cursor = block.ParentBlockId;
            while (cursor.HasValue)
            {
                if (!seen.Add(cursor.Value))
                {
                    errors.Add(new ValidationErrorDto { Code = ValidationCodes.TreeCycle, BlockId = block.Id });
                    break;
                }
                if (!byId.TryGetValue(cursor.Value, out var parent)) break;
                cursor = parent.ParentBlockId;
            }
        }

        // Pass 3: scrape blocks — bindings + config ownership.
        var configIds = dto.Blocks
            .Where(b => b.BlockType == BlockType.Scrape && b.Scrape is not null && b.Scrape.ScraperConfigId != Guid.Empty)
            .Select(b => b.Scrape!.ScraperConfigId)
            .Distinct()
            .ToList();

        var ownedConfigIds = configIds.Count == 0
            ? new HashSet<Guid>()
            : (await _db.ScraperConfigs
                .Where(c => c.UserId == userId && configIds.Contains(c.Id))
                .Select(c => c.Id)
                .ToListAsync(ct)).ToHashSet();

        foreach (var block in dto.Blocks.Where(b => b.BlockType == BlockType.Scrape && b.Scrape is not null))
        {
            var scrape = block.Scrape!;
            if (scrape.ScraperConfigId != Guid.Empty && !ownedConfigIds.Contains(scrape.ScraperConfigId))
                errors.Add(new ValidationErrorDto { Code = ValidationCodes.ConfigNotOwned, BlockId = block.Id, ScraperConfigId = scrape.ScraperConfigId });

            // Compute ancestor loop ids for this scrape block.
            var ancestors = new HashSet<Guid>();
            var cursor = block.ParentBlockId;
            while (cursor.HasValue && byId.TryGetValue(cursor.Value, out var parent))
            {
                ancestors.Add(parent.Id);
                cursor = parent.ParentBlockId;
            }

            foreach (var (stepId, binding) in scrape.StepBindings)
            {
                switch (binding.Kind)
                {
                    case BindingKind.Literal:
                        if (binding.Value is null)
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.BindingLiteralMissingValue, BlockId = block.Id, StepId = stepId });
                        break;
                    case BindingKind.LoopRef:
                        if (!binding.LoopBlockId.HasValue || !byId.ContainsKey(binding.LoopBlockId.Value))
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefMissing, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        else if (byId[binding.LoopBlockId.Value].BlockType != BlockType.Loop)
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefNotLoop, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        else if (!ancestors.Contains(binding.LoopBlockId.Value))
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefNonAncestor, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        break;
                    case BindingKind.Unbound:
                        break;
                }
            }
        }

        return errors;
    }
}

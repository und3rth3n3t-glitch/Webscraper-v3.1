using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public static class ValidationCodes
{
    public const string MissingTaskName            = "MISSING_TASK_NAME";
    public const string DuplicateBlockId           = "DUPLICATE_BLOCK_ID";
    public const string InvalidParentReference     = "INVALID_PARENT_REFERENCE";
    public const string TreeCycle                  = "TREE_CYCLE";
    public const string InvalidBlockConfig         = "INVALID_BLOCK_CONFIG";
    public const string MissingLoopName            = "MISSING_LOOP_NAME";
    public const string LoopRefNonAncestor         = "LOOP_REF_NON_ANCESTOR";
    public const string LoopRefMissing             = "LOOP_REF_MISSING";
    public const string LoopRefNotLoop             = "LOOP_REF_NOT_LOOP";
    public const string LoopColumnNotFound         = "LOOP_COLUMN_NOT_FOUND";
    public const string BindingLiteralMissingValue = "BINDING_LITERAL_MISSING_VALUE";
    public const string ConfigNotOwned             = "CONFIG_NOT_OWNED";
}

public interface ITaskValidator
{
    Task<List<ValidationErrorDto>> ValidateAsync(Guid userId, SaveTaskDto dto, CancellationToken ct = default);
}
